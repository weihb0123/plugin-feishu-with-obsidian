"use strict";

const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const EXCALIDRAW_PLUGIN_ID = "obsidian-excalidraw-plugin";
const BINDINGS_KEY = "excalidrawPdfBindings";
const pendingExports = new Map();
let imageExportQueue = Promise.resolve();

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function drawingTitle(file) {
  return file.basename.replace(/\.excalidraw$/i, "");
}

function findExcalidrawReferences(markdown, sourceFile, plugin) {
  const references = [];
  const seen = new Set();
  const pattern = /!?\[\[([^\]|#]+?)(?:#[^\]|]+)?(?:\\?\|[^\]]+)?\]\]/g;
  let match;

  while ((match = pattern.exec(markdown)) !== null) {
    const target = plugin.resolveWikiLinkTargetFile(match[1].trim(), sourceFile);
    if (!target || typeof target.path !== "string" || !plugin.isExcalidrawDrawing(target) || seen.has(target.path)) continue;
    seen.add(target.path);
    references.push(target);
  }

  return references;
}

async function withImageExportLock(callback) {
  const previous = imageExportQueue;
  let release;
  imageExportQueue = new Promise((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await callback();
  } finally {
    release();
  }
}

async function exportDrawingToImage(plugin, file, outputDirectory) {
  return withImageExportLock(async () => {
    const excalidraw = plugin.app.plugins.getPlugin(EXCALIDRAW_PLUGIN_ID);
    const automate = globalThis.ExcalidrawAutomate;
    if (!excalidraw || !automate?.getAPI) throw new Error("Excalidraw 插件未启用，无法导出图片");

    const outputPath = path.join(outputDirectory, `${plugin.sanitizeFileName(drawingTitle(file))}.png`);
    const ea = automate.getAPI();

    try {
      const image = await ea.createPNG(file.path, 2, {
        withBackground: true,
        withTheme: true,
        isMask: false,
      });
      if (!image) throw new Error(`Excalidraw 无法渲染：${file.path}`);
      const bytes = image instanceof ArrayBuffer
        ? new Uint8Array(image)
        : ArrayBuffer.isView(image)
          ? new Uint8Array(image.buffer, image.byteOffset, image.byteLength)
          : new Uint8Array(await image.arrayBuffer());
      await fs.writeFile(outputPath, bytes);
      return outputPath;
    } finally {
      ea.destroy?.();
    }
  });
}

async function uploadDrawingImage(plugin, file, documentToken, tempDirectory) {
  const imagePath = await exportDrawingToImage(plugin, file, tempDirectory);
  const filename = `${drawingTitle(file)}.png`;
  const attachmentsDirectory = path.join(tempDirectory, "attachments");
  const uploadFilename = plugin.sanitizeFileName(filename);
  await fs.mkdir(attachmentsDirectory, { recursive: true });
  await fs.copyFile(imagePath, path.join(attachmentsDirectory, uploadFilename));

  const media = {
    type: "image",
    original: `EXCALIDRAW-IMAGE:${file.path}`,
    filename,
    absolutePath: imagePath,
    uploadFilename,
  };
  const uploaded = await plugin.uploadMediaInline(documentToken, [media], tempDirectory, "Excalidraw Image");
  const resource = uploaded.get(media.original);
  if (!resource) throw new Error(`Excalidraw 图片上传失败：${file.path}`);

  const dimensions = resource.width && resource.height
    ? ` width="${resource.width}" height="${resource.height}"`
    : "";
  const xml = [
    `<title>${escapeXml(drawingTitle(file))}</title>`,
    "<p>Excalidraw 绘图预览</p>",
    `<img src="${escapeXml(resource.token)}" name="${escapeXml(filename)}"${dimensions}/>`
  ].join("\n");
  await fs.writeFile(path.join(tempDirectory, "excalidraw.xml"), xml, "utf8");
  await plugin.runLarkCli([
    "docs", "+update", "--api-version", "v2", "--as", "user",
    "--doc", documentToken, "--command", "overwrite", "--doc-format", "xml",
    "--content", "@excalidraw.xml",
  ], { cwd: tempDirectory });
}

async function createDrawingDocument(plugin, file, parent) {
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "oblark-sync-excalidraw-"));
  try {
    const title = drawingTitle(file);
    await fs.writeFile(
      path.join(tempDirectory, "skeleton.xml"),
      `<title>${escapeXml(title)}</title>\n<p>Excalidraw 绘图预览正在生成...</p>`,
      "utf8",
    );
    const args = [
      "docs", "+create", "--api-version", "v2", "--as", "user",
      "--title", title, "--doc-format", "xml", "--content", "@skeleton.xml",
    ];
    const destination = parent || await plugin.resolveRemoteRootParent();
    if (destination.token) args.push("--parent-token", destination.token);
    else args.push("--parent-position", "my_library");

    const response = await plugin.runLarkCli(args, { cwd: tempDirectory });
    const document = response.data?.document;
    const wikiNode = response.data?.wiki_node;
    const documentToken = document?.document_id;
    const url = wikiNode?.url || document?.url || response.data?.url;
    if (!documentToken || !url) throw new Error("创建 Excalidraw 飞书文档失败");
    await uploadDrawingImage(plugin, file, documentToken, tempDirectory);
    return { token: documentToken, documentToken, url };
  } finally {
    await fs.rm(tempDirectory, { force: true, recursive: true });
  }
}

function tokenFromBinding(binding) {
  if (binding.documentToken) return binding.documentToken;
  if (binding.token && !String(binding.url || "").includes("/wiki/")) return binding.token;
  return String(binding.url || "").match(/\/docx\/([^/?#]+)/)?.[1] || "";
}

function directDocumentBinding(binding) {
  const token = String(binding?.url || "").match(/\/docx\/([^/?#]+)/)?.[1];
  return token ? { ...binding, token } : null;
}

async function updateDrawingDocument(plugin, file, binding) {
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "oblark-sync-excalidraw-"));
  try {
    const token = tokenFromBinding(binding);
    if (!token) throw new Error(`无法解析 Excalidraw 飞书文档 token：${file.path}`);
    await uploadDrawingImage(plugin, file, token, tempDirectory);
    return { ...binding, documentToken: token };
  } finally {
    await fs.rm(tempDirectory, { force: true, recursive: true });
  }
}

async function persistBinding(plugin, file, binding) {
  plugin.settings[BINDINGS_KEY] ||= {};
  plugin.settings[BINDINGS_KEY][file.path] = {
    token: binding.token,
    documentToken: binding.documentToken,
    url: binding.url,
    sourceMtime: file.stat.mtime,
  };
  await plugin.saveSettings();
  return { ...binding, transientExcalidrawPdf: true };
}

async function syncDrawing(plugin, file, parent, originalGetBinding, force = false) {
  const key = `${file.path}:${file.stat.mtime}:${force}`;
  if (pendingExports.has(key)) return pendingExports.get(key);

  const task = (async () => {
    const stored = plugin.settings[BINDINGS_KEY]?.[file.path];
    let binding = stored || directDocumentBinding(originalGetBinding.call(plugin, file));
    if (binding && !await plugin.validateRemoteBinding(binding)) binding = null;
    if (!force && binding && stored?.sourceMtime === file.stat.mtime) {
      return { ...binding, transientExcalidrawPdf: true };
    }

    const result = binding
      ? await updateDrawingDocument(plugin, file, binding)
      : await createDrawingDocument(plugin, file, parent);
    return persistBinding(plugin, file, result);
  })().finally(() => pendingExports.delete(key));

  pendingExports.set(key, task);
  return task;
}

function installExcalidrawPdfSync(PluginClass) {
  if (!PluginClass || PluginClass.prototype.__excalidrawPdfSyncInstalled) return;
  const prototype = PluginClass.prototype;
  prototype.__excalidrawPdfSyncInstalled = true;

  const originalGetBinding = prototype.getBinding;
  const originalProcessLinks = prototype.processWikiLinksForSubDocuments;
  const originalCreateDocument = prototype.createLarkDocument;
  const originalUpdateDocument = prototype.updateLarkDocument;
  const originalSyncFileInternal = prototype.syncFileInternal;
  const originalShouldWriteBinding = prototype.shouldWriteBinding;

  console.info("[ObLark Sync] Installing Excalidraw image sync hooks");

  prototype.isExcalidrawDrawing = function (file) {
    const excalidraw = this.app.plugins.getPlugin(EXCALIDRAW_PLUGIN_ID);
    if (excalidraw?.isExcalidrawFile?.(file)) return true;
    if (file.path.toLowerCase().endsWith(".excalidraw.md")) return true;
    return this.app.metadataCache.getFileCache(file)?.frontmatter?.["excalidraw-plugin"] !== undefined;
  };

  prototype.getBinding = function (file) {
    if (this.isExcalidrawDrawing(file)) {
      const stored = this.settings[BINDINGS_KEY]?.[file.path];
      if (stored) return stored;
    }
    return originalGetBinding.call(this, file);
  };

  prototype.shouldWriteBinding = function (previous, next, enabled) {
    if (next?.transientExcalidrawPdf) return false;
    return originalShouldWriteBinding.call(this, previous, next, enabled);
  };

  prototype.processWikiLinksForSubDocuments = async function (markdown, sourceFile, parent, visited) {
    const drawings = findExcalidrawReferences(markdown, sourceFile, this);
    if (drawings.length > 0) {
      console.info(`[ObLark Sync] Found ${drawings.length} referenced Excalidraw drawing(s) in ${sourceFile.path}`);
    }
    for (const drawing of drawings) {
      await syncDrawing(this, drawing, parent, originalGetBinding);
    }
    return originalProcessLinks.call(this, markdown, sourceFile, parent, visited);
  };

  prototype.createLarkDocument = async function (file, content, parent, visited) {
    if (this.isExcalidrawDrawing(file)) return syncDrawing(this, file, parent, originalGetBinding);
    return originalCreateDocument.call(this, file, content, parent, visited);
  };

  prototype.updateLarkDocument = async function (token, content, options) {
    const file = this.app.vault.getAbstractFileByPath(options.path);
    if (file && typeof file.path === "string" && this.isExcalidrawDrawing(file)) {
      const binding = this.getBinding(file) || { token };
      const result = await updateDrawingDocument(this, file, binding);
      return persistBinding(this, file, result);
    }
    return originalUpdateDocument.call(this, token, content, options);
  };

  prototype.syncFileInternal = async function (file, options) {
    if (file && typeof file.path === "string" && this.isExcalidrawDrawing(file)) {
      const result = await syncDrawing(this, file, undefined, originalGetBinding, true);
      if (options.showSuccess) this.showSuccess(this.t(options.successMessageKey || "noticeSyncedToLark"), result.url);
      if (options.openAfterSync) this.openUrlIfNeeded(result.url);
      return result;
    }
    return originalSyncFileInternal.call(this, file, options);
  };

  prototype.refreshReferencedExcalidrawPdfs = async function (markdown, sourceFile, parent) {
    for (const drawing of findExcalidrawReferences(markdown, sourceFile, this)) {
      await syncDrawing(this, drawing, parent, originalGetBinding);
    }
  };
}

function scheduleExcalidrawPdfSyncInstall(pluginModule) {
  let attempts = 0;
  const install = () => {
    attempts += 1;
    try {
      const PluginClass = pluginModule?.default;
      if (!PluginClass) {
        if (attempts < 50) setTimeout(install, 20);
        return false;
      }
      installExcalidrawPdfSync(PluginClass);
      console.info("[ObLark Sync] Excalidraw image sync extension installed");
      return true;
    } catch (error) {
      console.error("[ObLark Sync] Failed to install Excalidraw image sync extension", error);
      return false;
    }
  };

  install();
}

module.exports = {
  installExcalidrawPdfSync,
  scheduleExcalidrawPdfSyncInstall,
  findExcalidrawReferences,
};
