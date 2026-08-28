"use strict";

/**
 * Excalidraw → 飞书高清 PNG 同步的单元回归测试。
 * 只依赖 node:test / node:assert，不引入第三方依赖。
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");

const sync = require("../excalidraw-pdf-sync.js");

/* ---------- 测试替身 ---------- */

class TFile {
  constructor(filePath, content, frontmatter, mtime) {
    this.path = filePath;
    this.name = filePath.slice(filePath.lastIndexOf("/") + 1);
    this.basename = this.name.replace(/\.md$/i, "");
    this.extension = "md";
    this.content = content ?? "";
    this.frontmatter = frontmatter;
    this.stat = { mtime: mtime ?? 1000 };
  }
}

class FakeMediaHandler {
  constructor() {
    this.delegated = [];
  }
  async resolveMedia(unit) {
    this.delegated.push(unit.filename);
    return null;
  }
}

class FakePlugin {
  constructor(files) {
    this.settings = {};
    this.saveCount = 0;
    this.cliCalls = [];
    this.uploadCalls = [];
    this.uploadCounter = 0;
    this.files = new Map(files.map((file) => [file.path, file]));
    const vaultFiles = () => Array.from(this.files.values());
    this.app = {
      plugins: { getPlugin: () => ({}) },
      metadataCache: {
        getFileCache: (file) => (file.frontmatter ? { frontmatter: file.frontmatter } : null),
        getFirstLinkpathDest: () => null,
      },
      vault: {
        getAbstractFileByPath: (target) => this.files.get(target) || null,
        getFiles: vaultFiles,
        getMarkdownFiles: vaultFiles,
        cachedRead: async (file) => file.content,
        read: async (file) => file.content,
      },
    };
  }

  sanitizeFileName(name) {
    return name.replace(/[\\/:*?"<>|\s]/g, "-").trim() || "note";
  }

  parentPath(target) {
    const index = target.lastIndexOf("/");
    return index >= 0 ? target.slice(0, index) : "";
  }

  resolveWikiLinkTargetFile(target, source) {
    const vault = this.app.vault;
    const direct = vault.getAbstractFileByPath(target)
      || vault.getAbstractFileByPath(target.endsWith(".md") ? target : `${target}.md`);
    if (direct) return direct;
    const parent = this.parentPath(source.path);
    const relative = target.replace(/^[/\\]/, "");
    const joined = parent ? `${parent}/${relative}` : relative;
    return vault.getAbstractFileByPath(joined)
      || vault.getAbstractFileByPath(joined.endsWith(".md") ? joined : `${joined}.md`)
      || this.app.metadataCache.getFirstLinkpathDest(target, source.path);
  }

  async saveSettings() {
    this.saveCount += 1;
  }

  async validateRemoteBinding() {
    return true;
  }

  async resolveRemoteRootParent() {
    return { token: "PARENT_TOKEN" };
  }

  async uploadMediaInline(documentToken, media, cwd) {
    this.uploadCalls.push({ documentToken, media: media.map((unit) => unit.original), cwd });
    const result = new Map();
    for (const unit of media) {
      this.uploadCounter += 1;
      result.set(unit.original, {
        token: `IMG_TOKEN_${this.uploadCounter}`,
        type: unit.type,
        filename: unit.filename,
        width: 1200,
        height: 900,
      });
    }
    return result;
  }

  async runLarkCli(args, options) {
    this.cliCalls.push({ args, cwd: options?.cwd });
    if (args[1] === "+create") {
      return { data: { document: { document_id: "NEW_DOC", url: "https://x.feishu.cn/docx/NEW_DOC" } } };
    }
    return { data: {} };
  }

  // 以下是被 install 包装的原始实现
  getBinding(file) {
    const url = file.frontmatter?.lark_doc_url;
    return url ? { token: "", url } : null;
  }
  shouldWriteBinding() {
    return true;
  }
  async readNoteForLark(file) {
    return file.content;
  }
  async processWikiLinksForSubDocuments() {
    return { linkMap: new Map() };
  }
  async createLarkDocument() {
    return { token: "ORIGINAL_CREATE", url: "https://x.feishu.cn/docx/ORIGINAL_CREATE" };
  }
  async updateLarkDocument() {
    return { token: "ORIGINAL_UPDATE" };
  }
  async syncFileInternal() {
    return { token: "ORIGINAL_SYNC" };
  }
  onunload() {}
}

const mediaHandler = new FakeMediaHandler();
sync.installExcalidrawPdfSync(FakePlugin, { MediaHandler: FakeMediaHandler });

/* ---------- PNG 替身 ---------- */

function pngBytes(width, height) {
  const buffer = Buffer.alloc(64);
  buffer.writeUInt32BE(0x89504e47, 0);
  buffer.writeUInt32BE(0x0d0a1a0a, 4);
  buffer.writeUInt32BE(13, 8);
  buffer.write("IHDR", 12);
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

function installExcalidrawAutomate(handler) {
  const state = { calls: [], destroyed: 0 };
  globalThis.ExcalidrawAutomate = {
    getAPI: () => ({
      async createPNG(drawingPath, scale) {
        state.calls.push({ drawingPath, scale });
        return handler(drawingPath, scale);
      },
      destroy() {
        state.destroyed += 1;
      },
    }),
  };
  return state;
}

const DRAWING_FRONTMATTER = { "excalidraw-plugin": "parsed" };

function newVault(drawingContent = "excalidraw-source-v1") {
  const drawing = new TFile("图纸/系统架构图.excalidraw.md", drawingContent, DRAWING_FRONTMATTER);
  const plainDrawing = new TFile("流程图.md", "flow-source-v1", DRAWING_FRONTMATTER);
  const note = new TFile("笔记/说明.md", "", undefined);
  const other = new TFile("笔记/普通笔记.md", "hello", { lark_doc_url: "https://x.feishu.cn/docx/OTHER" });
  return { drawing, plainDrawing, note, other, plugin: new FakePlugin([drawing, plainDrawing, note, other]) };
}

test.beforeEach(async () => {
  await sync.resetExcalidrawSyncCaches();
});

/* ---------- 1. 引用识别 ---------- */

test("collectExcalidrawReferences 识别各种 wikilink 形态并去重", () => {
  const vault = newVault();
  const markdown = [
    "[[图纸/系统架构图.excalidraw.md]]",
    "![[图纸/系统架构图.excalidraw]]",
    "![[图纸/系统架构图.excalidraw.md|架构图]]",
    "[[流程图]]",
    "![[流程图|说明]]",
    "[[普通笔记]]",
    "![[photo.png]]",
    "`[[流程图]]`",
    "```",
    "[[图纸/系统架构图.excalidraw.md]]",
    "```",
  ].join("\n");

  const references = sync.collectExcalidrawReferences(markdown, vault.note, vault.plugin);
  const byPath = new Map(references.map((entry) => [entry.file.path, entry.occurrences]));

  assert.deepEqual(
    Array.from(byPath.keys()).sort(),
    ["图纸/系统架构图.excalidraw.md", "流程图.md"],
  );
  assert.deepEqual(byPath.get("图纸/系统架构图.excalidraw.md"), [
    "[[图纸/系统架构图.excalidraw.md]]",
    "![[图纸/系统架构图.excalidraw]]",
    "![[图纸/系统架构图.excalidraw.md|架构图]]",
  ]);
  // 行内 code / fenced code 内的引用不参与改写
  assert.deepEqual(byPath.get("流程图.md"), ["[[流程图]]", "![[流程图|说明]]"]);
  assert.deepEqual(sync.findExcalidrawReferences(markdown, vault.note, vault.plugin).map((f) => f.path).sort(), [
    "图纸/系统架构图.excalidraw.md",
    "流程图.md",
  ]);
});

test("相对路径引用可被解析", () => {
  const drawing = new TFile("笔记/子目录/草图.excalidraw.md", "src", DRAWING_FRONTMATTER);
  const note = new TFile("笔记/说明.md", "", undefined);
  const plugin = new FakePlugin([drawing, note]);
  const references = sync.collectExcalidrawReferences("![[子目录/草图.excalidraw.md|图]]", note, plugin);
  assert.equal(references.length, 1);
  assert.equal(references[0].file.path, "笔记/子目录/草图.excalidraw.md");
});

test("parseWikiLinkTarget 处理别名、锚点与转义竖线", () => {
  assert.equal(sync.parseWikiLinkTarget("![[a/b.excalidraw.md|别名]]"), "a/b.excalidraw.md");
  assert.equal(sync.parseWikiLinkTarget("[[a#标题]]"), "a");
  assert.equal(sync.parseWikiLinkTarget("![[a\\|别名]]"), "a");
  assert.equal(sync.parseWikiLinkTarget("not a link"), "");
});

/* ---------- 2. 正文改写 ---------- */

test("readNoteForLark 把 Excalidraw 引用改写为 PNG 嵌入，普通链接保持不变", async () => {
  const vault = newVault();
  const state = installExcalidrawAutomate(() => pngBytes(1200, 900));
  vault.note.content = [
    "# 标题",
    "[[图纸/系统架构图.excalidraw.md]]",
    "![[图纸/系统架构图.excalidraw]]",
    "正文引用 ![[图纸/系统架构图.excalidraw.md|架构图]] 结束",
    "[[普通笔记]]",
    "![[photo.png]]",
  ].join("\n");

  const rendered = await vault.plugin.readNoteForLark(vault.note);
  const expected = `![[${sync.buildPreviewFilename(vault.plugin, vault.drawing, require("crypto").createHash("sha256").update("excalidraw-source-v1").digest("hex"))}]]`;

  assert.equal(state.calls.length, 1, "同一绘图多次引用只导出一次");
  assert.equal(state.calls[0].scale, 3, "默认使用最高倍率导出");
  assert.equal(rendered.split(expected).length - 1, 3, "三处引用都被替换为同一个 PNG 嵌入");
  assert.match(rendered, /\[\[普通笔记\]\]/);
  assert.match(rendered, /!\[\[photo\.png\]\]/);
  assert.ok(!rendered.includes("系统架构图.excalidraw"), "原始 Excalidraw wikilink 已全部替换");
});

test("内容未变化不重复导出，内容变化才重新导出", async () => {
  const vault = newVault();
  const state = installExcalidrawAutomate(() => pngBytes(1200, 900));
  vault.note.content = "![[图纸/系统架构图.excalidraw.md]]";

  const first = await vault.plugin.readNoteForLark(vault.note);
  const second = await vault.plugin.readNoteForLark(vault.note);
  assert.equal(state.calls.length, 1, "未修改绘图重复同步不再导出");
  assert.equal(first, second);

  vault.drawing.content = "excalidraw-source-v2";
  vault.drawing.stat.mtime = 2000;
  const third = await vault.plugin.readNoteForLark(vault.note);
  assert.equal(state.calls.length, 2, "绘图内容变化触发重新导出");
  assert.notEqual(third, first, "PNG 文件名随内容 hash 变化，父文档正文因此发生变更");
});

test("导出失败时正文保持原样（退回子文档链接），并且不上传任何内容", async () => {
  const vault = newVault();
  installExcalidrawAutomate(() => {
    throw new Error("boom");
  });
  vault.note.content = "![[图纸/系统架构图.excalidraw.md]]";
  const rendered = await vault.plugin.readNoteForLark(vault.note);
  assert.equal(rendered, "![[图纸/系统架构图.excalidraw.md]]");
  assert.equal(vault.plugin.uploadCalls.length, 0);
});

/* ---------- 3. 媒体解析补丁 ---------- */

test("resolveMedia 命中虚拟 PNG，其它文件仍走原实现", async () => {
  const vault = newVault();
  installExcalidrawAutomate(() => pngBytes(800, 600));
  const preview = await sync.ensureDrawingPreview(vault.plugin, vault.drawing);

  const handler = new FakeMediaHandler();
  const resolved = await handler.resolveMedia({ type: "image", filename: preview.filename, original: "x" });
  assert.equal(resolved.absolutePath, preview.absolutePath);
  assert.equal(resolved.type, "image");
  assert.equal(resolved.uploadFilename, "");
  assert.ok(fs.existsSync(resolved.absolutePath));

  const passthrough = await handler.resolveMedia({ type: "image", filename: "photo.png", original: "y" });
  assert.equal(passthrough, null);
  assert.deepEqual(handler.delegated, ["photo.png"]);
});

/* ---------- 4. 高画质与降级 ---------- */

test("超大画布按阶梯降级并记录日志", async () => {
  const vault = newVault();
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    installExcalidrawAutomate((_p, scale) => (scale === 3 ? pngBytes(20000, 18000) : pngBytes(9000, 7000)));
    const preview = await sync.ensureDrawingPreview(vault.plugin, vault.drawing);
    assert.equal(preview.exportScale, 2);
    assert.equal(preview.width, 9000);
    assert.ok(warnings.some((line) => line.includes("降级")), "降级必须留日志");
  } finally {
    console.warn = originalWarn;
  }
});

/* ---------- 5. 上传返回结构 ---------- */

test("uploadDrawingImage 返回结构化结果并写出转义后的 XML", async () => {
  const vault = newVault();
  installExcalidrawAutomate(() => pngBytes(1200, 900));
  const drawing = new TFile('图纸/a"b<c>.excalidraw.md', "src", DRAWING_FRONTMATTER);
  vault.plugin.files.set(drawing.path, drawing);
  const tempDirectory = await fsp.mkdtemp(path.join(os.tmpdir(), "oblark-test-"));
  try {
    const result = await sync.uploadDrawingImage(vault.plugin, drawing, "DOC_TOKEN", tempDirectory);
    assert.deepEqual(
      { ...result, sourceHash: "<hash>" },
      {
        imageToken: "IMG_TOKEN_1",
        width: 1200,
        height: 900,
        filename: 'a"b<c>.png',
        exportScale: 3,
        exportConfig: sync.EXPORT_CONFIG_ID,
        sourceHash: "<hash>",
      },
    );
    const xml = await fsp.readFile(path.join(tempDirectory, "excalidraw.xml"), "utf8");
    assert.match(xml, /<img src="IMG_TOKEN_1" name="a&quot;b&lt;c&gt;\.png" width="1200" height="900"\/>/);
    assert.match(xml, /<title>a&quot;b&lt;c&gt;<\/title>/);
    const overwrite = vault.plugin.cliCalls.find((call) => call.args.includes("overwrite"));
    assert.ok(overwrite, "必须对绘图子文档执行 overwrite");
    assert.deepEqual(overwrite.args.slice(0, 4), ["docs", "+update", "--api-version", "v2"]);
  } finally {
    await fsp.rm(tempDirectory, { force: true, recursive: true });
  }
});

/* ---------- 6. binding 持久化与迁移 ---------- */

test("persistBinding 落盘全部字段并保留旧的 documentToken / url", async () => {
  const vault = newVault();
  vault.plugin.settings[sync.BINDINGS_KEY] = {
    [vault.drawing.path]: { token: "OLD", documentToken: "OLD_DOC", url: "https://x.feishu.cn/wiki/OLD", sourceMtime: 1 },
  };
  const result = await sync.persistBinding(vault.plugin, vault.drawing, {
    imageToken: "IMG_1",
    width: 100,
    height: 50,
    sourceHash: "hash-1",
    exportScale: 3,
    exportConfig: sync.EXPORT_CONFIG_ID,
  });
  const stored = vault.plugin.settings[sync.BINDINGS_KEY][vault.drawing.path];
  assert.deepEqual(stored, {
    token: "OLD",
    documentToken: "OLD_DOC",
    url: "https://x.feishu.cn/wiki/OLD",
    imageToken: "IMG_1",
    width: 100,
    height: 50,
    sourceMtime: 1000,
    sourceHash: "hash-1",
    exportScale: 3,
    exportConfig: sync.EXPORT_CONFIG_ID,
  });
  assert.equal(result.transientExcalidrawPdf, true);
  assert.equal(vault.plugin.saveCount, 1);
});

test("needsDrawingRefresh 覆盖强制 / 缺字段 / 内容变化 / 配置变化", () => {
  const file = new TFile("图纸/x.excalidraw.md", "src", DRAWING_FRONTMATTER);
  const complete = {
    imageToken: "t",
    sourceHash: "h1",
    sourceMtime: 1000,
    exportConfig: sync.EXPORT_CONFIG_ID,
  };
  assert.equal(sync.needsDrawingRefresh(complete, file, "h1").refresh, false);
  assert.equal(sync.needsDrawingRefresh(complete, file, "h1", true).reason, "force");
  assert.equal(sync.needsDrawingRefresh(null, file, "h1").reason, "missing-binding");
  assert.equal(sync.needsDrawingRefresh({ ...complete, imageToken: "" }, file, "h1").reason, "missing-image-token");
  assert.equal(sync.needsDrawingRefresh({ ...complete, sourceHash: "" }, file, "h1").reason, "missing-source-hash");
  assert.equal(sync.needsDrawingRefresh(complete, file, "h2").reason, "source-changed");
  assert.equal(sync.needsDrawingRefresh({ ...complete, exportConfig: "old" }, file, "h1").reason, "export-config-changed");
});

test("旧 binding 缺 imageToken 时迁移：更新已有文档而不新建，并回填新字段", async () => {
  const vault = newVault();
  installExcalidrawAutomate(() => pngBytes(1200, 900));
  vault.plugin.settings[sync.BINDINGS_KEY] = {
    [vault.drawing.path]: {
      token: "LEGACY_DOC",
      documentToken: "LEGACY_DOC",
      url: "https://x.feishu.cn/docx/LEGACY_DOC",
      sourceMtime: vault.drawing.stat.mtime,
    },
  };

  const result = await vault.plugin.syncFileInternal(vault.drawing, {});
  const stored = vault.plugin.settings[sync.BINDINGS_KEY][vault.drawing.path];
  assert.equal(stored.documentToken, "LEGACY_DOC", "不得丢弃已有 documentToken");
  assert.equal(stored.url, "https://x.feishu.cn/docx/LEGACY_DOC", "不得丢弃已有 url");
  assert.equal(stored.imageToken, "IMG_TOKEN_1");
  assert.equal(stored.exportScale, 3);
  assert.equal(stored.exportConfig, sync.EXPORT_CONFIG_ID);
  assert.equal(typeof stored.sourceHash, "string");
  assert.ok(stored.sourceHash.length === 64);
  assert.equal(result.transientExcalidrawPdf, true);
  assert.ok(!vault.plugin.cliCalls.some((call) => call.args.includes("+create")), "不得为旧 binding 重复建文档");
  assert.equal(vault.plugin.uploadCalls.length, 1);
  assert.equal(vault.plugin.uploadCalls[0].documentToken, "LEGACY_DOC");
});

test("binding 已是最新时不再导出上传，仅回填 mtime", async () => {
  const vault = newVault();
  const state = installExcalidrawAutomate(() => pngBytes(1200, 900));
  const sourceHash = require("crypto").createHash("sha256").update(vault.drawing.content).digest("hex");
  vault.plugin.settings[sync.BINDINGS_KEY] = {
    [vault.drawing.path]: {
      token: "DOC",
      documentToken: "DOC",
      url: "https://x.feishu.cn/docx/DOC",
      imageToken: "IMG_OLD",
      sourceMtime: 1,
      sourceHash,
      exportScale: 3,
      exportConfig: sync.EXPORT_CONFIG_ID,
    },
  };

  await vault.plugin.updateLarkDocument("DOC", "content", { path: vault.drawing.path });
  assert.equal(state.calls.length, 0, "内容未变不重新导出");
  assert.equal(vault.plugin.uploadCalls.length, 0, "内容未变不重新上传");
  assert.equal(vault.plugin.settings[sync.BINDINGS_KEY][vault.drawing.path].sourceMtime, 1000);
});

test("同一绘图并发同步只上传一次", async () => {
  const vault = newVault();
  const state = installExcalidrawAutomate(() => pngBytes(600, 400));
  const [a, b] = await Promise.all([
    vault.plugin.updateLarkDocument("DOC_A", "c", { path: vault.drawing.path }),
    vault.plugin.updateLarkDocument("DOC_A", "c", { path: vault.drawing.path }),
  ]);
  assert.equal(state.calls.length, 1);
  assert.equal(vault.plugin.uploadCalls.length, 1);
  assert.equal(a.imageToken, b.imageToken);
});

/* ---------- 7. 不破坏既有钩子 ---------- */

test("非 Excalidraw 文件仍走原始同步实现，toLinkTarget 未被改写", async () => {
  const vault = newVault();
  const created = await vault.plugin.createLarkDocument(vault.other, "content");
  assert.equal(created.token, "ORIGINAL_CREATE");
  const updated = await vault.plugin.updateLarkDocument("T", "c", { path: vault.other.path });
  assert.equal(updated.token, "ORIGINAL_UPDATE");
  const synced = await vault.plugin.syncFileInternal(vault.other, {});
  assert.equal(synced.token, "ORIGINAL_SYNC");
  assert.equal(FakePlugin.prototype.toLinkTarget, undefined, "本方案不改写 toLinkTarget/cite 渲染");
});

test("escapeXml 转义 XML 关键字符", () => {
  assert.equal(sync.escapeXml('a&b<c>"d"'), "a&amp;b&lt;c&gt;&quot;d&quot;");
});

test.after(async () => {
  await sync.resetExcalidrawSyncCaches();
  assert.ok(mediaHandler instanceof FakeMediaHandler);
});
