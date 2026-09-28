"use strict";

const crypto = require("crypto");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

const EXCALIDRAW_PLUGIN_ID = "obsidian-excalidraw-plugin";
const BINDINGS_KEY = "excalidrawPdfBindings";
const PREVIEW_MARKER = "oblark-excalidraw";
// Excalidraw 导出对话框最高倍率是 3x，失败时按阶梯有限降级（每次降级都会写日志）
const PREVIEW_EXPORT_SCALES = [3, 2, 1];
const PREVIEW_EXPORT_SETTINGS = { withBackground: true, withTheme: true, isMask: false };
// 导出配置指纹：变化时旧 binding 会被判定为需要重新导出
// v2：取消体积上限，只保留浏览器画布的硬限制
const EXPORT_CONFIG_ID = "png-ladder-3-2-1:bg+theme:v2-nosizecap";
// 不对 PNG 体积设上限：lark-cli 的 media-upload 对 >20MB 的文件会自动走分片上传
// （见 `lark-cli docs +media-upload --help`：files > 20MB use multipart upload automatically）
// 下面两个是 Chromium 画布的硬限制，不是飞书限制：超了渲染出来的是空白/破图，
// 属于"渲染不可用"而不是"画质取舍"，所以必须继续拦。
const PREVIEW_MAX_EDGE = 65535;
const PREVIEW_MAX_PIXELS = 268435456;
// 与 main.js 内联媒体替换用的正则保持一致，保证 map key 与被替换文本完全相同
const WIKILINK_PATTERN = /!?\[\[[^\]|]+(?:\|[^\]]+)?\]\]/g;

const pendingExports = new Map();
const pendingPreviews = new Map();
/** drawingPath -> preview */
const previewCache = new Map();
/** 虚拟媒体文件名 -> preview（供 MediaHandler.resolveMedia 命中） */
const virtualMedia = new Map();
let imageExportQueue = Promise.resolve();
let previewDirectory = null;
let mediaResolverPatched = false;
let atomicWriteCounter = 0;
let obsidianModule;

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}

function notifyUser(message) {
  if (obsidianModule === undefined) {
    try {
      obsidianModule = require("obsidian");
    } catch {
      obsidianModule = null; /* 非 Obsidian 运行环境（单元测试） */
    }
  }
  if (typeof obsidianModule?.Notice === "function") new obsidianModule.Notice(message, 8000);
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : undefined;
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function drawingTitle(file) {
  return file.basename.replace(/\.excalidraw$/i, "");
}

/** 标记 fenced code block 与行内 code 的字符区间，避免改写代码里的 wikilink */
function collectCodeRanges(markdown) {
  const ranges = [];
  let offset = 0;
  let fence = null;

  for (const line of String(markdown).split("\n")) {
    const trimmed = line.trim();
    const fenceMatch = /^(`{3,}|~{3,})/.exec(trimmed);
    if (fence) {
      ranges.push([offset, offset + line.length]);
      if (fenceMatch && trimmed.startsWith(fence)) fence = null;
    } else if (fenceMatch) {
      fence = fenceMatch[1];
      ranges.push([offset, offset + line.length]);
    } else {
      const inline = /`[^`\n]*`/g;
      let match;
      while ((match = inline.exec(line)) !== null) {
        ranges.push([offset + match.index, offset + match.index + match[0].length]);
      }
    }
    offset += line.length + 1;
  }

  return ranges;
}

function isInsideRanges(ranges, index) {
  for (const [start, end] of ranges) {
    if (index >= start && index < end) return true;
  }
  return false;
}

function parseWikiLinkTarget(matched) {
  const inner = /^!?\[\[([\s\S]+)\]\]$/.exec(matched);
  if (!inner) return "";
  let target = inner[1];
  const alias = target.indexOf("|");
  if (alias >= 0) target = target.slice(0, alias).replace(/\\$/, "");
  const heading = target.indexOf("#");
  if (heading >= 0) target = target.slice(0, heading);
  return target.trim();
}

function tryResolveTargetFile(plugin, target, sourceFile) {
  try {
    const file = plugin.resolveWikiLinkTargetFile(target, sourceFile);
    return file && typeof file.path === "string" ? file : null;
  } catch {
    return null;
  }
}

/**
 * 解析 wikilink 指向的绘图文件。
 * 先按 Obsidian 自身的解析规则找：能找到文件就以它为准（找到的不是绘图就不是绘图，
 * 不去猜同名的 .excalidraw 文件，避免把普通笔记链接劫持成画图）。
 * 只有完全找不到时，才补试 `.excalidraw` / `.excalidraw.md` 后缀。
 */
function resolveDrawingFile(plugin, target, sourceFile) {
  if (!target) return null;
  const direct = tryResolveTargetFile(plugin, target, sourceFile);
  if (direct) return plugin.isExcalidrawDrawing(direct) ? direct : null;
  if (/\.excalidraw(\.md)?$/i.test(target)) return null;
  for (const suffix of [".excalidraw", ".excalidraw.md"]) {
    const file = tryResolveTargetFile(plugin, `${target}${suffix}`, sourceFile);
    if (file && plugin.isExcalidrawDrawing(file)) return file;
  }
  return null;
}

/**
 * 收集 markdown 中所有指向 Excalidraw 绘图的 wikilink。
 * 返回 [{ file, occurrences: [被匹配的原始文本, ...] }]
 */
function collectExcalidrawReferences(markdown, sourceFile, plugin) {
  if (typeof markdown !== "string" || !markdown) return [];
  const ranges = collectCodeRanges(markdown);
  const resolved = new Map();
  const references = new Map();
  const pattern = new RegExp(WIKILINK_PATTERN.source, "g");
  let match;

  while ((match = pattern.exec(markdown)) !== null) {
    if (isInsideRanges(ranges, match.index)) continue;
    const target = parseWikiLinkTarget(match[0]);
    if (!target) continue;
    if (!resolved.has(target)) resolved.set(target, resolveDrawingFile(plugin, target, sourceFile));
    const file = resolved.get(target);
    if (!file) continue;
    let entry = references.get(file.path);
    if (!entry) {
      entry = { file, occurrences: [] };
      references.set(file.path, entry);
    }
    if (!entry.occurrences.includes(match[0])) entry.occurrences.push(match[0]);
  }

  return Array.from(references.values());
}

/** 兼容旧签名：仅返回被引用的绘图文件列表 */
function findExcalidrawReferences(markdown, sourceFile, plugin) {
  return collectExcalidrawReferences(markdown, sourceFile, plugin).map((entry) => entry.file);
}

/**
 * 串行化导出。注意两点：
 * 1. 前一个任务无论成败都不能卡住队列，所以 await 前一个任务时吞掉异常；
 * 2. release 必须在任何路径下都被调用，否则整个插件生命周期内的导出都会永久挂住。
 */
async function withImageExportLock(callback) {
  const previous = imageExportQueue;
  let release = () => {};
  imageExportQueue = new Promise((resolve) => {
    release = resolve;
  });
  try {
    await previous.catch(() => {});
    return await callback();
  } finally {
    release();
  }
}

async function ensurePreviewDirectory() {
  if (previewDirectory) return previewDirectory;
  previewDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "oblark-sync-excalidraw-"));
  return previewDirectory;
}

async function cleanupPreviewDirectory() {
  const directory = previewDirectory;
  previewDirectory = null;
  previewCache.clear();
  virtualMedia.clear();
  if (!directory) return;
  try {
    await fs.rm(directory, { force: true, recursive: true });
  } catch (error) {
    console.warn(`[ObLark Sync] 清理 Excalidraw 预览临时目录失败：${describeError(error)}`);
  }
}

function readPngSize(bytes) {
  if (!bytes || bytes.length < 24) return null;
  if (bytes[0] !== 137 || bytes[1] !== 80 || bytes[2] !== 78 || bytes[3] !== 71) return null;
  const view = Buffer.from(bytes.buffer || bytes, bytes.byteOffset || 0, bytes.length);
  return { width: view.readUInt32BE(16), height: view.readUInt32BE(20) };
}

async function toUint8Array(image) {
  if (image instanceof ArrayBuffer) return new Uint8Array(image);
  if (ArrayBuffer.isView(image)) return new Uint8Array(image.buffer, image.byteOffset, image.byteLength);
  if (typeof image.arrayBuffer === "function") return new Uint8Array(await image.arrayBuffer());
  throw new Error("Excalidraw 返回了无法识别的图片数据类型");
}

function resolveExcalidrawApi(plugin, file) {
  const excalidraw = plugin.app?.plugins?.getPlugin?.(EXCALIDRAW_PLUGIN_ID);
  if (!excalidraw) throw new Error(`Excalidraw 插件未启用，无法导出图片：${file.path}`);
  const automate = globalThis.ExcalidrawAutomate;
  if (!automate) throw new Error(`ExcalidrawAutomate API 不可用，无法导出图片：${file.path}`);
  const api = typeof automate.getAPI === "function" ? automate.getAPI() : automate;
  if (!api || typeof api.createPNG !== "function") {
    throw new Error(`ExcalidrawAutomate.createPNG 不可用，无法导出图片：${file.path}`);
  }
  return { api, owned: api !== automate };
}

/** 按最高画质优先的倍率阶梯导出 PNG；降级必须留日志，不允许静默降质 */
async function renderDrawingPng(plugin, file) {
  const { api, owned } = resolveExcalidrawApi(plugin, file);
  const problems = [];
  const lastScale = PREVIEW_EXPORT_SCALES[PREVIEW_EXPORT_SCALES.length - 1];

  try {
    for (const scale of PREVIEW_EXPORT_SCALES) {
      let bytes;
      try {
        const image = await api.createPNG(file.path, scale, { ...PREVIEW_EXPORT_SETTINGS });
        if (!image) throw new Error("createPNG 返回空结果");
        bytes = await toUint8Array(image);
        if (bytes.length === 0) throw new Error("createPNG 返回空数据");
      } catch (error) {
        problems.push(`scale=${scale}: ${describeError(error)}`);
        console.error(`[ObLark Sync] Excalidraw 导出失败（scale=${scale}）：${file.path}`, error);
        continue;
      }

      const size = readPngSize(bytes);
      // 只在浏览器画布确实渲染不出来的情况下降级；体积多大都照传
      const unrenderable = !!size
        && (size.width > PREVIEW_MAX_EDGE
          || size.height > PREVIEW_MAX_EDGE
          || size.width * size.height > PREVIEW_MAX_PIXELS);
      if (unrenderable && scale !== lastScale) {
        const reason = `尺寸 ${size.width}x${size.height} 超过浏览器画布上限`;
        problems.push(`scale=${scale}: ${reason}`);
        console.warn(`[ObLark Sync] Excalidraw 画布超出浏览器渲染上限，降级导出倍率：${file.path}（${reason}）`);
        continue;
      }

      if (scale !== PREVIEW_EXPORT_SCALES[0]) {
        console.warn(
          `[ObLark Sync] Excalidraw 已降级为 scale=${scale} 导出：${file.path}（最高画质失败原因：${problems.join("; ")}）`,
        );
      }
      return { bytes, exportScale: scale, width: size?.width, height: size?.height };
    }
  } finally {
    if (owned) api.destroy?.();
  }

  throw new Error(`Excalidraw PNG 导出失败：${file.path}（${problems.join("; ") || "未知原因"}）`);
}

async function readDrawingSource(plugin, file) {
  const vault = plugin.app?.vault;
  if (vault?.cachedRead) return vault.cachedRead(file);
  if (vault?.read) return vault.read(file);
  throw new Error(`无法读取 Excalidraw 源文件：${file.path}`);
}

function buildPreviewFilename(plugin, file, sourceHash) {
  const base = plugin.sanitizeFileName(drawingTitle(file)) || "excalidraw";
  return `${base}.${PREVIEW_MARKER}-${sourceHash.slice(0, 12)}.png`;
}

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * 先写临时文件再 rename。同目录 rename 是原子操作，
 * 保证读方（媒体上传）永远看不到写了一半的 PNG。
 */
async function writeFileAtomic(targetPath, bytes) {
  const temporaryPath = `${targetPath}.${process.pid}-${(atomicWriteCounter += 1)}.part`;
  try {
    await fs.writeFile(temporaryPath, bytes);
    await fs.rename(temporaryPath, targetPath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

/** 设置写盘失败不应该让一次已经成功的远端同步整体失败 */
async function saveSettingsSafely(plugin, context) {
  try {
    await plugin.saveSettings();
    return true;
  } catch (error) {
    console.warn(`[ObLark Sync] 保存设置失败（${context}）：${describeError(error)}`);
    return false;
  }
}

/**
 * 保证绘图存在一份与当前内容一致的高清 PNG。
 * 内容未变化时直接复用缓存，不重复导出（同一批次的重复引用同样只导出一次）。
 */
async function ensureDrawingPreview(plugin, file, force = false) {
  const sourceHash = sha256(await readDrawingSource(plugin, file));
  const cached = previewCache.get(file.path);
  if (!force && cached && cached.sourceHash === sourceHash && (await pathExists(cached.absolutePath))) {
    virtualMedia.set(cached.filename, cached);
    return cached;
  }

  const key = `${file.path}:${sourceHash}`;
  // 已有同内容的导出在进行中就直接复用：force 的语义是"不吃缓存"，
  // 而进行中的任务本身就是一次全新导出，重复跑只会浪费 CPU 并争抢同一个文件。
  const inflight = pendingPreviews.get(key);
  if (inflight) return inflight;

  const task = (async () => {
    const rendered = await withImageExportLock(() => renderDrawingPng(plugin, file));
    const directory = await ensurePreviewDirectory();
    const filename = buildPreviewFilename(plugin, file, sourceHash);
    const absolutePath = path.join(directory, filename);
    await writeFileAtomic(absolutePath, rendered.bytes);

    const preview = {
      drawingPath: file.path,
      filename,
      absolutePath,
      sourceHash,
      exportScale: rendered.exportScale,
      exportConfig: EXPORT_CONFIG_ID,
      width: rendered.width,
      height: rendered.height,
      byteLength: rendered.bytes.length,
    };

    const previous = previewCache.get(file.path);
    if (previous && previous.absolutePath !== absolutePath) {
      virtualMedia.delete(previous.filename);
      await fs.rm(previous.absolutePath, { force: true }).catch(() => {});
    }
    previewCache.set(file.path, preview);
    virtualMedia.set(filename, preview);
    console.info(
      `[ObLark Sync] Excalidraw 预览已导出：${file.path} → ${filename}（scale=${preview.exportScale}, ${preview.width ?? "?"}x${preview.height ?? "?"}）`,
    );
    return preview;
  })().finally(() => {
    if (pendingPreviews.get(key) === task) pendingPreviews.delete(key);
  });

  pendingPreviews.set(key, task);
  return task;
}

/**
 * 把笔记里的 Excalidraw wikilink 改写为指向导出 PNG 的图片嵌入。
 * 后续沿用主插件既有的媒体链路（resolveMedia → uploadMediaInline → <img/>），
 * 因此图片 token 天然属于父文档，不存在跨文档 token 作用域问题。
 * 任何一步失败都保持原文本不变，退回旧的飞书子文档链接行为。
 */
async function prepareMarkdownForExcalidraw(plugin, markdown, sourceFile) {
  if (!mediaResolverPatched) return markdown;
  if (typeof markdown !== "string" || !markdown) return markdown;
  if (!sourceFile || typeof sourceFile.path !== "string") return markdown;
  if (plugin.isExcalidrawDrawing(sourceFile)) return markdown;

  const references = collectExcalidrawReferences(markdown, sourceFile, plugin);
  if (references.length === 0) return markdown;

  const replacements = new Map();
  for (const reference of references) {
    try {
      const preview = await ensureDrawingPreview(plugin, reference.file);
      for (const occurrence of reference.occurrences) {
        replacements.set(occurrence, `![[${preview.filename}]]`);
      }
    } catch (error) {
      const message = `Excalidraw 预览生成失败，${reference.file.path} 退回飞书子文档链接：${describeError(error)}`;
      console.error(`[ObLark Sync] ${message}`, error);
      notifyUser(message);
    }
  }
  if (replacements.size === 0) return markdown;

  const ranges = collectCodeRanges(markdown);
  const pattern = new RegExp(WIKILINK_PATTERN.source, "g");
  return markdown.replace(pattern, (matched, offset) => {
    if (isInsideRanges(ranges, offset)) return matched;
    return replacements.get(matched) ?? matched;
  });
}

/** 上传绘图 PNG 到指定飞书文档，并返回结构化结果 */
async function uploadDrawingImage(plugin, file, documentToken, tempDirectory, preview) {
  const resolved = preview || (await ensureDrawingPreview(plugin, file));
  const filename = `${drawingTitle(file)}.png`;
  const attachmentsDirectory = path.join(tempDirectory, "attachments");
  const uploadFilename = plugin.sanitizeFileName(filename);
  await fs.mkdir(attachmentsDirectory, { recursive: true });
  await fs.copyFile(resolved.absolutePath, path.join(attachmentsDirectory, uploadFilename));

  const media = {
    type: "image",
    original: `EXCALIDRAW-IMAGE:${file.path}`,
    filename,
    absolutePath: resolved.absolutePath,
    uploadFilename,
  };
  const uploaded = await plugin.uploadMediaInline(documentToken, [media], tempDirectory, "Excalidraw Image");
  const resource = uploaded.get(media.original);
  if (!resource || !resource.token) throw new Error(`Excalidraw 图片上传失败：${file.path}`);

  const width = positiveInteger(resource.width) ?? positiveInteger(resolved.width);
  const height = positiveInteger(resource.height) ?? positiveInteger(resolved.height);
  const dimensions = width && height ? ` width="${width}" height="${height}"` : "";
  const xml = [
    `<title>${escapeXml(drawingTitle(file))}</title>`,
    "<p>Excalidraw 绘图预览</p>",
    `<img src="${escapeXml(resource.token)}" name="${escapeXml(filename)}"${dimensions}/>`,
  ].join("\n");
  await fs.writeFile(path.join(tempDirectory, "excalidraw.xml"), xml, "utf8");
  await plugin.runLarkCli([
    "docs", "+update", "--api-version", "v2", "--as", "user",
    "--doc", documentToken, "--command", "overwrite", "--doc-format", "xml",
    "--content", "@excalidraw.xml",
  ], { cwd: tempDirectory });

  return {
    imageToken: resource.token,
    width,
    height,
    filename,
    exportScale: resolved.exportScale,
    sourceHash: resolved.sourceHash,
    exportConfig: resolved.exportConfig || EXPORT_CONFIG_ID,
  };
}

/**
 * 创建绘图子文档。
 * preview 传 undefined 表示自动导出；显式传 null 表示降级：只建占位骨架、不上传图片。
 */
async function createDrawingDocument(plugin, file, parent, preview) {
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
    if (preview === null) {
      console.warn(`[ObLark Sync] ${file.path} 仅创建了占位子文档，下次同步会补齐预览图`);
      return { token: documentToken, documentToken, url };
    }
    const image = await uploadDrawingImage(plugin, file, documentToken, tempDirectory, preview);
    return { token: documentToken, documentToken, url, ...image };
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

async function updateDrawingDocument(plugin, file, binding, preview) {
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "oblark-sync-excalidraw-"));
  try {
    const token = tokenFromBinding(binding);
    if (!token) throw new Error(`无法解析 Excalidraw 飞书文档 token：${file.path}`);
    const image = await uploadDrawingImage(plugin, file, token, tempDirectory, preview);
    return { ...binding, documentToken: token, ...image };
  } finally {
    await fs.rm(tempDirectory, { force: true, recursive: true });
  }
}

/** 写入 binding，保留用户已有的 documentToken / url，不因缺字段丢数据 */
async function persistBinding(plugin, file, binding) {
  plugin.settings[BINDINGS_KEY] ||= {};
  const previous = plugin.settings[BINDINGS_KEY][file.path] || {};
  const next = {
    token: binding.token || previous.token,
    documentToken: binding.documentToken || previous.documentToken,
    url: binding.url || previous.url,
    imageToken: binding.imageToken || previous.imageToken,
    width: positiveInteger(binding.width) ?? positiveInteger(previous.width),
    height: positiveInteger(binding.height) ?? positiveInteger(previous.height),
    sourceMtime: file.stat?.mtime,
    sourceHash: binding.sourceHash || previous.sourceHash,
    exportScale: binding.exportScale ?? previous.exportScale,
    exportConfig: binding.exportConfig || previous.exportConfig,
  };
  plugin.settings[BINDINGS_KEY][file.path] = next;
  await saveSettingsSafely(plugin, `binding ${file.path}`);
  return { ...binding, ...next, transientExcalidrawPdf: true };
}

/**
 * 是否需要重新导出并上传。
 * 不只看 mtime：缺 imageToken / 缺 sourceHash / 内容 hash 变化 / 导出配置变化都会触发。
 */
function needsDrawingRefresh(stored, file, sourceHash, force = false) {
  if (force) return { refresh: true, reason: "force" };
  if (!stored) return { refresh: true, reason: "missing-binding" };
  if (!stored.imageToken) return { refresh: true, reason: "missing-image-token" };
  if (!stored.sourceHash) return { refresh: true, reason: "missing-source-hash" };
  if (stored.sourceHash !== sourceHash) return { refresh: true, reason: "source-changed" };
  if (stored.exportConfig !== EXPORT_CONFIG_ID) return { refresh: true, reason: "export-config-changed" };
  return { refresh: false, reason: "up-to-date" };
}

async function syncDrawing(plugin, file, parent, originalGetBinding, force = false, fallbackBinding, degradeOnFailure = true) {
  const sourceHash = sha256(await readDrawingSource(plugin, file));
  const key = `${file.path}:${sourceHash}:${force}`;
  if (pendingExports.has(key)) return pendingExports.get(key);

  const task = (async () => {
    const stored = plugin.settings?.[BINDINGS_KEY]?.[file.path];
    let binding = stored
      || directDocumentBinding(originalGetBinding.call(plugin, file))
      || (fallbackBinding && tokenFromBinding(fallbackBinding) ? fallbackBinding : null);
    if (binding && !await plugin.validateRemoteBinding(binding)) binding = null;

    const decision = needsDrawingRefresh(binding === stored ? stored : null, file, sourceHash, force);
    if (binding && !decision.refresh) {
      if (stored.sourceMtime !== file.stat?.mtime) {
        stored.sourceMtime = file.stat?.mtime;
        await saveSettingsSafely(plugin, `mtime ${file.path}`);
      }
      return { ...binding, transientExcalidrawPdf: true };
    }
    console.info(`[ObLark Sync] Excalidraw 需要刷新（${decision.reason}）：${file.path}`);

    let preview;
    try {
      preview = await ensureDrawingPreview(plugin, file, force);
    } catch (error) {
      if (!degradeOnFailure) throw error;
      // 导出失败：不动远端已有内容，退回子文档链接，并保留上一次有效 binding
      const message = `Excalidraw 预览生成失败，${file.path} 保留原有远端内容：${describeError(error)}`;
      console.error(`[ObLark Sync] ${message}`, error);
      notifyUser(message);
      if (binding) return { ...binding, transientExcalidrawPdf: true };
      return persistBinding(plugin, file, await createDrawingDocument(plugin, file, parent, null));
    }

    const result = binding
      ? await updateDrawingDocument(plugin, file, binding, preview)
      : await createDrawingDocument(plugin, file, parent, preview);
    return persistBinding(plugin, file, result);
  })().finally(() => pendingExports.delete(key));

  pendingExports.set(key, task);
  return task;
}

function installMediaResolverPatch(internals) {
  const MediaHandler = internals?.MediaHandler;
  if (typeof MediaHandler !== "function" || typeof MediaHandler.prototype?.resolveMedia !== "function") {
    console.warn("[ObLark Sync] 未取到媒体解析器，Excalidraw 引用将退回飞书子文档链接模式");
    return false;
  }
  if (MediaHandler.prototype.__oblarkExcalidrawPatched) {
    mediaResolverPatched = true;
    return true;
  }
  const originalResolveMedia = MediaHandler.prototype.resolveMedia;
  MediaHandler.prototype.resolveMedia = async function (unit, sourcePath) {
    const preview = unit && typeof unit.filename === "string" ? virtualMedia.get(unit.filename) : undefined;
    if (preview) {
      return { ...unit, type: "image", vaultPath: "", absolutePath: preview.absolutePath, uploadFilename: "" };
    }
    return originalResolveMedia.call(this, unit, sourcePath);
  };
  MediaHandler.prototype.__oblarkExcalidrawPatched = true;
  mediaResolverPatched = true;
  return true;
}

function installExcalidrawPdfSync(PluginClass, internals) {
  if (!PluginClass || PluginClass.prototype.__excalidrawPdfSyncInstalled) return;
  const prototype = PluginClass.prototype;
  prototype.__excalidrawPdfSyncInstalled = true;

  const originalGetBinding = prototype.getBinding;
  const originalProcessLinks = prototype.processWikiLinksForSubDocuments;
  const originalCreateDocument = prototype.createLarkDocument;
  const originalUpdateDocument = prototype.updateLarkDocument;
  const originalSyncFileInternal = prototype.syncFileInternal;
  const originalShouldWriteBinding = prototype.shouldWriteBinding;
  const originalReadNote = prototype.readNoteForLark;
  const originalOnunload = prototype.onunload;

  console.info("[ObLark Sync] Installing Excalidraw image sync hooks");
  installMediaResolverPatch(internals);

  prototype.isExcalidrawDrawing = function (file) {
    if (!file || typeof file.path !== "string") return false;
    const excalidraw = this.app.plugins.getPlugin(EXCALIDRAW_PLUGIN_ID);
    if (excalidraw?.isExcalidrawFile?.(file)) return true;
    if (file.path.toLowerCase().endsWith(".excalidraw.md")) return true;
    return this.app.metadataCache.getFileCache(file)?.frontmatter?.["excalidraw-plugin"] !== undefined;
  };

  prototype.getBinding = function (file) {
    if (this.isExcalidrawDrawing(file)) {
      const stored = this.settings?.[BINDINGS_KEY]?.[file.path];
      if (stored) return stored;
    }
    return originalGetBinding.call(this, file);
  };

  prototype.shouldWriteBinding = function (previous, next, enabled) {
    if (next?.transientExcalidrawPdf) return false;
    return originalShouldWriteBinding.call(this, previous, next, enabled);
  };

  // 唯一的内容改写入口：所有上行同步（单文件 / 目录发布 / 子文档）都经过 readNoteForLark
  prototype.readNoteForLark = async function (file) {
    const content = await originalReadNote.call(this, file);
    try {
      return await prepareMarkdownForExcalidraw(this, content, file);
    } catch (error) {
      console.error(`[ObLark Sync] Excalidraw 预处理失败，按原文同步：${file?.path}`, error);
      return content;
    }
  };

  // 兜底：若内容改写失败，wikilink 仍留在正文里，这里保证仍有子文档可引用（退回 cite）
  prototype.processWikiLinksForSubDocuments = async function (markdown, sourceFile, parent, visited) {
    const drawings = findExcalidrawReferences(markdown, sourceFile, this);
    if (drawings.length > 0) {
      console.info(
        `[ObLark Sync] ${sourceFile.path} 中有 ${drawings.length} 个未内联的 Excalidraw 引用，退回子文档模式`,
      );
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
      return syncDrawing(this, file, undefined, originalGetBinding, false, token ? { token } : undefined);
    }
    return originalUpdateDocument.call(this, token, content, options);
  };

  prototype.syncFileInternal = async function (file, options) {
    if (file && typeof file.path === "string" && this.isExcalidrawDrawing(file)) {
      // 用户显式同步绘图本身：不做静默降级，失败要抛给上层提示
      const result = await syncDrawing(this, file, undefined, originalGetBinding, true, undefined, false);
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

  prototype.onunload = function () {
    cleanupPreviewDirectory().catch(() => {});
    return originalOnunload?.call(this);
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
        else console.error("[ObLark Sync] 等待插件类超时，Excalidraw 图片同步扩展未安装");
        return false;
      }
      installExcalidrawPdfSync(PluginClass, pluginModule?.__oblarkInternals);
      console.info("[ObLark Sync] Excalidraw image sync extension installed");
      return true;
    } catch (error) {
      console.error("[ObLark Sync] Failed to install Excalidraw image sync extension", error);
      return false;
    }
  };

  install();
}

/** 供测试使用：清空导出缓存与临时目录 */
async function resetExcalidrawSyncCaches() {
  pendingExports.clear();
  pendingPreviews.clear();
  await cleanupPreviewDirectory();
}

module.exports = {
  installExcalidrawPdfSync,
  scheduleExcalidrawPdfSyncInstall,
  findExcalidrawReferences,
  collectExcalidrawReferences,
  prepareMarkdownForExcalidraw,
  ensureDrawingPreview,
  uploadDrawingImage,
  createDrawingDocument,
  updateDrawingDocument,
  persistBinding,
  needsDrawingRefresh,
  buildPreviewFilename,
  parseWikiLinkTarget,
  collectCodeRanges,
  escapeXml,
  resetExcalidrawSyncCaches,
  EXPORT_CONFIG_ID,
  PREVIEW_EXPORT_SCALES,
  BINDINGS_KEY,
};
