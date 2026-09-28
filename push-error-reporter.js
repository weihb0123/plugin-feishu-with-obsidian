"use strict";

const { AsyncLocalStorage } = require("async_hooks");
const { randomUUID } = require("crypto");
const fs = require("fs/promises");
const path = require("path");

const DEFAULT_REPORT_FILE_NAME = "push-error-reports.json";
const DEFAULT_MAX_REPORTS = 100;
const REPORT_VERSION = 1;
const REDACTED = "[REDACTED]";
const MAX_MESSAGE_LENGTH = 2000;
const MAX_CONTEXT_DEPTH = 5;
const writeQueues = new Map();
const reportedErrors = new WeakSet();
const operationContext = new AsyncLocalStorage();

function isSensitiveKey(key) {
  const normalized = String(key).replace(/[^a-z0-9]/gi, "").toLowerCase();
  const resourceIdentifiers = new Set(["doc", "docid", "documentid", "spreadsheetid", "whiteboardid", "folderid", "parentid"]);
  return normalized.includes("token") ||
    normalized.includes("secret") ||
    normalized.includes("password") ||
    normalized.includes("authorization") ||
    normalized.includes("credential") ||
    normalized.includes("apikey") ||
    resourceIdentifiers.has(normalized);
}

function sanitizeString(value, maxLength = MAX_MESSAGE_LENGTH) {
  let sanitized = String(value);
  sanitized = sanitized.replace(
    /(\/(?:docx|wiki|base|sheets|file|folder|whiteboard)\/)([A-Za-z0-9_-]+)/gi,
    `$1${REDACTED}`,
  );
  sanitized = sanitized.replace(
    /([?&](?:access[_-]?token|token|app[_-]?secret|client[_-]?secret|api[_-]?key|password)=)[^&#\s"'<>]+/gi,
    `$1${REDACTED}`,
  );
  sanitized = sanitized.replace(
    /((?:authorization|app[_-]?secret|client[_-]?secret|access[_-]?token|api[_-]?key|password|token|document[_-]?id|doc[_-]?id|spreadsheet[_-]?token|whiteboard[_-]?token|folder[_-]?token)\s*[:=]\s*)(?:bearer\s+)?(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi,
    `$1${REDACTED}`,
  );
  sanitized = sanitized.replace(
    /(\b(?:token|secret|password|credential|document[_-]?id|doc[_-]?id)\b\s+(?:(?:is|was)\s+)?)([A-Za-z0-9._~+\/-]{6,})/gi,
    `$1${REDACTED}`,
  );
  sanitized = sanitized.replace(/(bearer\s+)[A-Za-z0-9._~+\/-]+/gi, `$1${REDACTED}`);
  sanitized = sanitized.replace(
    /(--(?:access-?token|token|doc|parent-token|folder-token|spreadsheet-token|whiteboard-token|app-secret|client-secret|password|api-key)(?:=|\s+))(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
    `$1${REDACTED}`,
  );
  if (sanitized.length > maxLength) {
    sanitized = `${sanitized.slice(0, maxLength)}…`;
  }
  return sanitized;
}

function sanitizeContext(value, depth = 0) {
  if (value === null || value === undefined) return value ?? null;
  if (depth >= MAX_CONTEXT_DEPTH) return "[TRUNCATED]";
  if (typeof value === "string") return sanitizeString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return String(value);
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((entry) => sanitizeContext(entry, depth + 1));
  }
  if (typeof value === "object") {
    const result = {};
    for (const [key, entry] of Object.entries(value).slice(0, 50)) {
      result[key] = isSensitiveKey(key) ? REDACTED : sanitizeContext(entry, depth + 1);
    }
    return result;
  }
  return sanitizeString(value);
}

function sanitizeErrorCode(error) {
  if (!error || !("code" in Object(error))) return undefined;
  const code = String(error.code);
  return /^[A-Z][A-Z0-9_.:-]{0,80}$/.test(code) ? code : undefined;
}

function buildPushErrorReport(options) {
  const error = options.error;
  const errorName = error instanceof Error ? error.name : typeof error;
  const message = error instanceof Error ? error.message : String(error);
  const timestamp = (options.now ? options.now() : new Date()).toISOString();
  const createReportId = options.createReportId || randomUUID;
  const report = {
    reportId: sanitizeString(createReportId(), 120),
    timestamp,
    operation: sanitizeString(options.operation || "push", 120),
    stage: sanitizeString(options.stage || "unknown", 120),
    filePath: sanitizeString(options.filePath || "", 500),
    errorName: sanitizeString(errorName || "Error", 120),
    message: sanitizeString(message),
    context: sanitizeContext(options.context || {}),
  };
  const code = sanitizeErrorCode(error);
  if (code !== undefined) report.code = code;
  return report;
}

function getPushErrorReportPath(vaultBasePath, pluginId = "oblark-sync") {
  return path.join(vaultBasePath, ".obsidian", "plugins", pluginId, DEFAULT_REPORT_FILE_NAME);
}

async function readReportStore(reportPath) {
  try {
    const parsed = JSON.parse(await fs.readFile(reportPath, "utf8"));
    if (parsed && parsed.version === REPORT_VERSION && Array.isArray(parsed.reports)) {
      return { version: REPORT_VERSION, reports: parsed.reports };
    }
  } catch {
    // Missing or malformed files are replaced by a fresh valid store.
  }
  return { version: REPORT_VERSION, reports: [] };
}

async function writeReportStore(reportPath, store) {
  const directory = path.dirname(reportPath);
  const tempPath = `${reportPath}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  await fs.mkdir(directory, { recursive: true });
  try {
    await fs.writeFile(tempPath, JSON.stringify(store, null, 2), "utf8");
    await fs.rename(tempPath, reportPath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function appendPushErrorReport(options) {
  if (!options || !options.reportPath) throw new TypeError("reportPath is required");
  const reportPath = path.resolve(options.reportPath);
  const previous = writeQueues.get(reportPath) || Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    const report = buildPushErrorReport(options);
    const store = await readReportStore(reportPath);
    const maxReports = Number.isFinite(options.maxReports)
      ? Math.max(1, Math.floor(options.maxReports))
      : DEFAULT_MAX_REPORTS;
    store.reports = [...store.reports, report].slice(-maxReports);
    await writeReportStore(reportPath, store);
    return report;
  });
  writeQueues.set(reportPath, next);
  try {
    return await next;
  } finally {
    if (writeQueues.get(reportPath) === next) writeQueues.delete(reportPath);
  }
}

function isAlreadyReported(error) {
  return error && (typeof error === "object" || typeof error === "function") && reportedErrors.has(error);
}

function markReported(error) {
  if (error && (typeof error === "object" || typeof error === "function")) reportedErrors.add(error);
}

function resolveVaultBasePath(plugin) {
  if (typeof plugin.getVaultBasePath === "function") {
    const value = plugin.getVaultBasePath();
    if (value) return value;
  }
  const adapter = plugin.app?.vault?.adapter;
  if (typeof adapter?.getBasePath === "function") return adapter.getBasePath();
  return adapter?.basePath || "";
}

async function recordPluginPushError(plugin, error, details) {
  if (isAlreadyReported(error)) return null;
  try {
    const vaultBasePath = resolveVaultBasePath(plugin);
    if (!vaultBasePath) throw new Error("vault base path is unavailable");
    const reportPath = getPushErrorReportPath(vaultBasePath, plugin.manifest?.id || "oblark-sync");
    const report = await appendPushErrorReport({ reportPath, error, ...details });
    markReported(error);
    console.warn(`[ObLark Sync] push failure report saved: ${reportPath} (${report.reportId})`);
    return report;
  } catch (reportError) {
    console.warn(
      "[ObLark Sync] failed to write push failure report; preserving original error:",
      reportError instanceof Error ? reportError.message : String(reportError),
    );
    return null;
  }
}

function wrapContextOperation(prototype, methodName, createContext) {
  const original = prototype[methodName];
  if (typeof original !== "function") return;
  prototype[methodName] = function (...args) {
    return operationContext.run(createContext.call(this, ...args), () => original.apply(this, args));
  };
}

function installPushErrorReporter(PluginClass) {
  const prototype = PluginClass?.prototype;
  if (!prototype || prototype.__pushErrorReporterInstalled) return false;

  Object.defineProperty(prototype, "__pushErrorReporterInstalled", {
    configurable: true,
    value: true,
  });

  const originalSyncFileInternal = prototype.syncFileInternal;
  if (typeof originalSyncFileInternal === "function") {
    prototype.syncFileInternal = async function (file, options = {}) {
      let stage = "sync-file";
      try {
        stage = typeof this.getBinding === "function" && this.getBinding(file)
          ? "document-update"
          : "document-create";
      } catch {
        // Stage detection must never affect the original push.
      }
      try {
        return await originalSyncFileInternal.call(this, file, options);
      } catch (error) {
        await recordPluginPushError(this, error, {
          operation: options.mode === "save" ? "auto-sync" : "single-note-push",
          stage,
          filePath: file?.path || "",
          context: {
            mode: options.mode || "manual",
            strategy: options.strategy || this.settings?.syncStrategy || "auto",
            allowCreate: Boolean(options.allowCreate),
          },
        });
        throw error;
      }
    };
  }

  const originalRunWithNotice = prototype.runWithNotice;
  if (typeof originalRunWithNotice === "function") {
    prototype.runWithNotice = function (message, operation, errorTemplate) {
      const context = operationContext.getStore();
      if (!context) return originalRunWithNotice.call(this, message, operation, errorTemplate);
      return originalRunWithNotice.call(this, message, async () => {
        try {
          return await operation();
        } catch (error) {
          await recordPluginPushError(this, error, context);
          throw error;
        }
      }, errorTemplate);
    };
  }

  wrapContextOperation(prototype, "publishFolder", (folderPath) => ({
    operation: "folder-publish",
    stage: "folder-sync",
    filePath: folderPath || "",
    context: { mode: "folder" },
  }));
  wrapContextOperation(prototype, "uploadFileAsSheet", (file) => ({
    operation: "sheet-upload",
    stage: "sheet-create",
    filePath: file?.path || "",
    context: { mode: "manual" },
  }));
  wrapContextOperation(prototype, "refreshFileSheet", (file) => ({
    operation: "sheet-refresh",
    stage: "sheet-update",
    filePath: file?.path || "",
    context: { mode: "manual" },
  }));

  return true;
}

function schedulePushErrorReporterInstall(mainExports) {
  return installPushErrorReporter(mainExports?.default || mainExports);
}

module.exports = {
  DEFAULT_MAX_REPORTS,
  DEFAULT_REPORT_FILE_NAME,
  REPORT_VERSION,
  appendPushErrorReport,
  buildPushErrorReport,
  getPushErrorReportPath,
  installPushErrorReporter,
  sanitizeContext,
  sanitizeString,
  schedulePushErrorReporterInstall,
};
