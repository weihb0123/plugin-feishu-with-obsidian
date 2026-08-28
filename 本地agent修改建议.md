# Excalidraw 图片转换 Bug 修复指南

---

## 一、Bug 描述

Obsidian 笔记中通过 `[[xxx]]` 引用的 Excalidraw 绘图文件（frontmatter 含 `excalidraw-plugin`），同步到飞书文档后只显示为文件链接，无法显示成图片缩略图。

**预期行为**：父文档中引用的 Excalidraw 绘图应该显示为图片缩略图，而不是文件链接。

**实际行为**：显示为 `<cite type="doc">` 文件引用链接。

---

## 二、当前状态

- `data.json` 中 `excalidrawPdfBindings` 为 `{}`，从未被触发过
- 飞书远端 `12to24V电路分析画板` 文档内容为原始文本 dump（含压缩 JSON 绘图数据），不是图片
- 父文档（test.md）中 wikilink 被替换为 `<cite type="doc" doc-id="H0qWdSKNLoCQgMxJ42IcqX5QnKh">`

---

## 三、需要修改的文件

### 文件 1：`excalidraw-pdf-sync.js`（完整路径见下方）

**修改 1：`uploadDrawingImage` 返回 image token（第 82-115 行）**

当前这个函数执行完上传后不返回 image token。需要改为返回 `resource.token`（图片的飞书 media token），让上层能拿到。

具体改动：
- 第 98 行：拿到 `resource`（包含 `token`, `width`, `height` 等）
- 第 110-114 行：执行完 overwrite 后
- 在第 115 行 `}` 之前，添加 `return { imageToken: resource.token, width: resource.width, height: resource.height };`

**修改 2：`updateDrawingDocument` 传递 imageToken（第 158-168 行）**

当前第 163 行调用 `await uploadDrawingImage(...)` 但没有接收返回值。需要改为：
```js
const imageInfo = await uploadDrawingImage(plugin, file, token, tempDirectory);
return { ...binding, documentToken: token, imageToken: imageInfo.imageToken, width: imageInfo.width, height: imageInfo.height };
```

**修改 3：`createDrawingDocument` 传递 imageToken（第 117-145 行）**

当前第 140 行调用 `await uploadDrawingImage(...)` 但没有接收返回值。同理需要改为：
```js
const imageInfo = await uploadDrawingImage(plugin, file, documentToken, tempDirectory);
return { token: documentToken, documentToken, url, imageToken: imageInfo.imageToken, width: imageInfo.width, height: imageInfo.height };
```

**修改 4：`persistBinding` 存储 imageToken（第 170-180 行）**

当前只存了 `{token, documentToken, url, sourceMtime}`。需要增加 `imageToken`, `width`, `height`：
```js
plugin.settings[BINDINGS_KEY][file.path] = {
  token: binding.token,
  documentToken: binding.documentToken,
  url: binding.url,
  imageToken: binding.imageToken,
  width: binding.width,
  height: binding.height,
  sourceMtime: file.stat.mtime,
};
```

**修改 5：`processWikiLinksForSubDocuments` hook 修改 linkMap（第 238-247 行）**

当前直接返回原始 process 的结果，没有修改 linkMap。需要改为：

```js
prototype.processWikiLinksForSubDocuments = async function (markdown, sourceFile, parent, visited) {
  const drawings = findExcalidrawReferences(markdown, sourceFile, this);
  if (drawings.length > 0) {
    console.info(`[ObLark Sync] Found ${drawings.length} referenced Excalidraw drawing(s) in ${sourceFile.path}`);
  }
  for (const drawing of drawings) {
    await syncDrawing(this, drawing, parent, originalGetBinding);
  }
  // 先调用原始 process，获得 linkMap
  const result = await originalProcessLinks.call(this, markdown, sourceFile, parent, visited);
  // 修改 linkMap 中 excalidraw 文件的条目，从 cite 改为 image 类型
  for (const drawing of drawings) {
    const binding = this.settings[BINDINGS_KEY]?.[drawing.path];
    if (!binding || !binding.imageToken) continue;
    // 将 linkMap 中所有指向该文件的条目替换为 image 标记
    const paths = this.getExcalidrawLinkPaths(drawing, sourceFile.path);
    for (const p of paths) {
      if (result.linkMap.has(p)) {
        result.linkMap.set(p, {
          token: binding.imageToken,
          url: binding.url,
          label: drawing.basename,
          isExcalidrawImage: true,
          width: binding.width,
          height: binding.height,
        });
      }
    }
  }
  return result;
};
```

同时需要在 `installExcalidrawPdfSync` 中新增一个辅助方法 `getExcalidrawLinkPaths`（放在 `isExcalidrawDrawing` 后面）：

```js
prototype.getExcalidrawLinkPaths = function (file, sourcePath) {
  const paths = new Set();
  const c = this.normalizeLinkPath(file.path);
  const l = this.normalizeLinkPath(file.path.slice(sourcePath.length).replace(/^\/+/, ""));
  paths.add(c);
  paths.add(l);
  paths.add(file.name);
  paths.add(file.basename);
  paths.add(this.normalizeLinkPath(file.path.replace(/\.md$/i, "")));
  paths.add(l.replace(/\.md$/i, ""));
  return paths;
};
```

### 文件 2：`main.js`（完整路径见下方）

**修改 6：`rewriteInternalLinks`（即 `re` 函数）支持 image 类型**

当前 `re` 函数定义如下（在 main.js 中搜索 `function re(r,i,t){return r.replace`）：

```js
function re(r,i,t){
  return r.replace(/\[([^\]]+)]\(([^)]+\.md(?:#[^)]+)?)\)/g,(o,s,a)=>{
    let c=st(a,i,t);
    return c?ne(c):o
  }).replace(/\[\[([^|\]#]+)(#[^|\]]+)?(?:\|([^\]]+))?\]\]/g,(o,s)=>{
    let a=st(s,i,t);
    return a?ne(a):o
  }).replace(/(?<![\](/])\b([A-Za-z0-9_. -]+\.md)(#[A-Za-z0-9_.% -]+)?\b/g,(o,s)=>{
    let a=st(s,i,t);
    return a?ne(a):o
  })
}
```

需要修改 `ne` 函数，使其对 `isExcalidrawImage` 类型的条目产生 `<img>` 标签：

当前 `ne` 函数：
```js
function ne(r){
  let i=r.token||Qr(r.url);
  return i?`<cite type="doc" doc-id="${ti(i)}"></cite>`:r.url
}
```

修改为：
```js
function ne(r){
  if(r.isExcalidrawImage){
    let dims = r.width && r.height ? ` width="${r.width}" height="${r.height}"` : "";
    return `<img src="${ti(r.token)}"${dims}/>`;
  }
  let i=r.token||Qr(r.url);
  return i?`<cite type="doc" doc-id="${ti(i)}"></cite>`:r.url
}
```

> **注意**：`main.js` 是 ESBuild 打包后的压缩文件（单行），需要在其中找到对应函数并修改。搜索 `function ne(r){let i=r.token||Qr(r.url)` 定位。

---

## 四、完整文件路径

- **excalidraw-pdf-sync.js**：`D:\obsidian\Box1_power_supply\电源项目笔记\.obsidian\plugins\oblark-syncV2\excalidraw-pdf-sync.js`
- **main.js**：`D:\obsidian\Box1_power_supply\电源项目笔记\.obsidian\plugins\oblark-syncV2\main.js`

---

## 五、excalidraw-pdf-sync.js 当前完整内容

```js
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
```

---

## 六、main.js 中需要修改的关键函数

> 注意：main.js 为 ESBuild 单行压缩输出，需要搜索函数签名定位。

### 6.1 `ne` 函数（wikilink → cite 标签转换）

**搜索定位**：`function ne(r){let i=r.token||Qr(r.url)`

**当前代码**：
```js
function ne(r){let i=r.token||Qr(r.url);return i?`<cite type="doc" doc-id="${ti(i)}"></cite>`:r.url}
```

**修改为**：
```js
function ne(r){if(r.isExcalidrawImage){let dims=r.width&&r.height?` width="${r.width}" height="${r.height}"`:"";return`<img src="${ti(r.token)}"${dims}/>`}let i=r.token||Qr(r.url);return i?`<cite type="doc" doc-id="${ti(i)}"></cite>`:r.url}
```

### 6.2 相关辅助函数（供参考，不需要修改）

```js
// 从 URL 提取 doc token
function Qr(r){return r.match(/\/docx\/([^/?#]+)/)?.[1]||""}

// XML 转义
function ti(r){return r.replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/</g,"&lt;").replace(/>/g,"&gt;")}

// 路径规范化
function ft(r){let i=[];for(let t of r.replace(/\\/g,"/").split("/"))if(!(!t||t===".")){if(t===".."){i.pop();continue}i.push(t)}return i.join("/")}
function ie(r){let i=r.lastIndexOf("/");return i>=0?r.slice(0,i):""}
```

---

## 七、验证方法

修复后，对引用 Excalidraw 的笔记（如 `test.md` → `12to24V电路分析画板`）重新 push：

1. 检查 `data.json` 中 `excalidrawPdfBindings` 有新的条目，且包含 `imageToken`
2. `12to24V电路分析画板` 的飞书文档应显示为图片（而非文本 dump）
3. `test.md` 飞书端中 `[[12to24V电路分析画板]]` 的位置应显示为图片缩略图