"use strict";

/**
 * 端到端（本地）集成测试：加载真实打包后的 main.js，跑通
 * readNoteForLark → createLarkDocument → yt/resolveMedia/uploadMediaInline → Z/z
 * 全链路，断言最终写给 lark-cli 的 Docx XML 内容。
 *
 * 不访问飞书：runLarkCli 被替换为桩，但 markdown→XML、媒体解析、
 * 内联媒体替换、cite 渲染全部使用 main.js 中的真实实现。
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");

/* ---------- obsidian 桩 ---------- */

class TFile {
  constructor(filePath, content, frontmatter, mtime) {
    this.path = filePath;
    this.name = filePath.slice(filePath.lastIndexOf("/") + 1);
    this.basename = this.name.replace(/\.[^.]+$/, "");
    this.extension = filePath.slice(filePath.lastIndexOf(".") + 1);
    this.content = content ?? "";
    this.frontmatter = frontmatter;
    this.stat = { mtime: mtime ?? 1000, size: (content ?? "").length };
  }
}
class TFolder {}

const notices = [];
const obsidianStub = {
  Plugin: class {},
  PluginSettingTab: class {},
  Modal: class {},
  Notice: class {
    constructor(message) {
      notices.push(String(message));
    }
    hide() {}
  },
  Setting: class {
    setName() { return this; }
    setDesc() { return this; }
    setHeading() { return this; }
    addText() { return this; }
    addToggle() { return this; }
    addDropdown() { return this; }
    addButton() { return this; }
  },
  TFile,
  TFolder,
  normalizePath: (value) => value,
  requestUrl: async () => ({}),
};

const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === "obsidian") return obsidianStub;
  return originalLoad.call(this, request, ...rest);
};

const mainModule = require("../main.js");
const excalidrawSync = require("../excalidraw-pdf-sync.js");
const PluginClass = mainModule.default;

/* ---------- 工具 ---------- */

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

async function buildHarness() {
  const vaultDirectory = await fsp.mkdtemp(path.join(os.tmpdir(), "oblark-vault-"));
  await fsp.writeFile(path.join(vaultDirectory, "photo.png"), pngBytes(640, 480));

  const note = new TFile("笔记/说明.md", "");
  const drawing = new TFile("图纸/系统架构图.excalidraw.md", "excalidraw-source-v1", { "excalidraw-plugin": "parsed" });
  const linked = new TFile("笔记/普通笔记.md", "# 普通笔记", { lark_doc_url: "https://x.feishu.cn/docx/OTHER_DOC" });
  const photo = new TFile("photo.png", "");
  const files = new Map([note, drawing, linked, photo].map((file) => [file.path, file]));

  const plugin = Object.create(PluginClass.prototype);
  plugin.settings = {
    language: "zh-CN",
    larkCliPath: "lark-cli",
    titleSource: "file-name",
    headingAutoNumber: false,
    frontmatterStripKeys: [],
    updateFrontmatter: false,
    syncStrategy: "auto",
    openAfterSync: false,
  };
  plugin.app = {
    plugins: { getPlugin: () => ({}) },
    metadataCache: {
      getFileCache: (file) => (file.frontmatter ? { frontmatter: file.frontmatter } : null),
      getFirstLinkpathDest: () => null,
    },
    vault: {
      adapter: { basePath: vaultDirectory },
      getAbstractFileByPath: (target) => files.get(target) || null,
      getFiles: () => Array.from(files.values()),
      getMarkdownFiles: () => Array.from(files.values()).filter((file) => file.extension === "md"),
      cachedRead: async (file) => file.content,
      read: async (file) => file.content,
    },
  };

  const cliCalls = [];
  const writtenXml = [];
  let mediaCounter = 0;
  plugin.runLarkCli = async (args, options) => {
    cliCalls.push(args);
    const command = args[1];
    const contentIndex = args.indexOf("--content");
    if (contentIndex >= 0 && String(args[contentIndex + 1]).startsWith("@")) {
      const fileName = args[contentIndex + 1].slice(1);
      writtenXml.push({
        command,
        doc: args.includes("--doc") ? args[args.indexOf("--doc") + 1] : args[args.indexOf("--title") + 1],
        xml: fs.readFileSync(path.join(options.cwd, fileName), "utf8"),
      });
    }
    if (command === "+create") {
      return { data: { document: { document_id: "PARENT_DOC", url: "https://x.feishu.cn/docx/PARENT_DOC" } } };
    }
    if (command === "+fetch") {
      return { data: { document: { document_id: "PARENT_DOC", content: '<p id="blk1">skeleton</p>', revision_id: 1 } } };
    }
    if (command === "+media-upload") {
      mediaCounter += 1;
      return { data: { file_token: `MEDIA_TOKEN_${mediaCounter}`, size: 1024 } };
    }
    return { data: {} };
  };
  plugin.validateRemoteBinding = async () => true;
  plugin.writeBinding = async () => {};
  plugin.resolveRemoteRootParent = async () => ({ kind: "wiki", token: "PARENT_SPACE" });
  plugin.saveSettings = async () => {};
  plugin.saveCreatedDocumentStateFromBaseline = async () => {};

  globalThis.ExcalidrawAutomate = {
    getAPI: () => ({
      async createPNG(_drawingPath, scale) {
        return pngBytes(400 * scale, 300 * scale);
      },
      destroy() {},
    }),
  };

  return { plugin, note, drawing, linked, cliCalls, writtenXml, vaultDirectory };
}

test.before(async () => {
  // main.js 在 process.nextTick 里安装扩展，等一轮事件循环
  await new Promise((resolve) => setTimeout(resolve, 30));
});

test.beforeEach(async () => {
  await excalidrawSync.resetExcalidrawSyncCaches();
});

test.after(async () => {
  await excalidrawSync.resetExcalidrawSyncCaches();
  Module._load = originalLoad;
});

test("扩展已挂载到真实插件类，且 cite 渲染逻辑未被改动", () => {
  assert.equal(PluginClass.prototype.__excalidrawPdfSyncInstalled, true);
  assert.equal(mainModule.__oblarkInternals.MediaHandler.prototype.__oblarkExcalidrawPatched, true);
  // readNoteForLark 可能被多个扩展依次包装，这里只断言已被接管；
  // Excalidraw 改写是否真的生效由下面的 XML 断言证明
  assert.match(
    PluginClass.prototype.readNoteForLark.toString(),
    /prepareMarkdownForExcalidraw|convertLarkLinksToCites/,
  );
  assert.equal(
    PluginClass.prototype.toLinkTarget.toString(),
    "toLinkTarget(t,e){return{token:e.token,url:e.url,label:t.basename}}",
  );
  const source = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  assert.ok(
    source.includes('function ne(r){let i=r.token||Qr(r.url);return i?`<cite type="doc" doc-id="${ti(i)}"></cite>`:r.url}'),
    "main.js 中的链接渲染函数必须保持原样（普通 wikilink 仍为 cite）",
  );
});

test("父文档 XML 在原引用位置输出高清 PNG，普通链接仍是 cite，普通图片不受影响", async () => {
  const harness = await buildHarness();
  const { plugin, note, drawing } = harness;
  note.content = [
    "---",
    "tags: [x]",
    "---",
    "# 架构说明",
    "",
    "[[图纸/系统架构图.excalidraw.md]]",
    "",
    "段落中的引用 ![[图纸/系统架构图.excalidraw|架构图]] 结束。",
    "",
    "![[photo.png]]",
    "",
    "参考 [[普通笔记]]。",
    "",
  ].join("\n");

  const content = await plugin.readNoteForLark(note);
  assert.ok(!content.includes("系统架构图.excalidraw"), "wikilink 已被改写为 PNG 嵌入");

  const result = await plugin.createLarkDocument(note, content, { kind: "wiki", token: "PARENT_SPACE" }, new Set());
  assert.equal(result.token, "PARENT_DOC");

  const overwrite = harness.writtenXml.filter((entry) => entry.command === "+update").at(-1);
  assert.equal(overwrite.doc, "PARENT_DOC");
  const xml = overwrite.xml;

  const previewName = `系统架构图.oblark-excalidraw-${require("crypto").createHash("sha256").update("excalidraw-source-v1").digest("hex").slice(0, 12)}.png`;
  const drawingImages = xml.match(new RegExp(`<img src="MEDIA_TOKEN_\\d+" name="${previewName.replace(/\./g, "\\.")}" width="1200" height="900"/>`, "g")) || [];
  assert.equal(drawingImages.length, 2, `两处 Excalidraw 引用都应渲染为图片块，实际 XML:\n${xml}`);
  assert.match(xml, /<img src="MEDIA_TOKEN_\d+" name="photo\.png" width="640" height="480"\/>/, "普通图片没有回归");
  assert.match(xml, /<cite type="doc" doc-id="OTHER_DOC"><\/cite>/, "普通 wikilink 仍渲染为 cite");
  assert.ok(!/\[图片: /.test(xml), "不应出现文件名占位");
  assert.ok(!/excalidraw-source/.test(xml), "不应把 Excalidraw 源文本写进正文");
  assert.ok(!xml.includes("<p><img"), "独立成行的图片应为独立块");

  // 图片 token 全部由父文档上传得到，不存在跨文档 token
  const uploads = harness.cliCalls.filter((args) => args[1] === "+media-upload");
  assert.equal(uploads.length, 2);
  for (const args of uploads) {
    assert.equal(args[args.indexOf("--doc-id") + 1], "PARENT_DOC");
    assert.equal(args[args.indexOf("--parent-type") + 1], "docx_image");
  }
  // 绘图不再产生多余的远端子文档
  assert.equal(harness.cliCalls.filter((args) => args[1] === "+create").length, 1);

  await fsp.rm(harness.vaultDirectory, { force: true, recursive: true });
});

test("绘图内容变化后父文档正文与图片 token 一起更新", async () => {
  const harness = await buildHarness();
  const { plugin, note, drawing } = harness;
  note.content = "# 说明\n\n![[图纸/系统架构图.excalidraw.md]]\n";

  const first = await plugin.readNoteForLark(note);
  await plugin.createLarkDocument(note, first, { kind: "wiki", token: "PARENT_SPACE" }, new Set());
  const firstXml = harness.writtenXml.filter((entry) => entry.command === "+update").at(-1).xml;

  drawing.content = "excalidraw-source-v2";
  drawing.stat.mtime = 2000;
  const second = await plugin.readNoteForLark(note);
  assert.notEqual(second, first, "绘图变化后推送内容必须变化，增量同步才能发现差异");
  await plugin.createLarkDocument(note, second, { kind: "wiki", token: "PARENT_SPACE" }, new Set());
  const secondXml = harness.writtenXml.filter((entry) => entry.command === "+update").at(-1).xml;

  const firstToken = /<img src="(MEDIA_TOKEN_\d+)"/.exec(firstXml)[1];
  const secondToken = /<img src="(MEDIA_TOKEN_\d+)"/.exec(secondXml)[1];
  assert.notEqual(firstToken, secondToken, "重新上传后应使用新的图片 token");
  assert.match(secondXml, /<img src="MEDIA_TOKEN_\d+" name="系统架构图\.oblark-excalidraw-[0-9a-f]{12}\.png"/);

  await fsp.rm(harness.vaultDirectory, { force: true, recursive: true });
});

test("更新路径（含目录发布）同样把绘图渲染为父文档图片", async () => {
  const harness = await buildHarness();
  const { plugin, note, drawing } = harness;
  plugin.syncState = { version: 1, documents: {} };
  plugin.buildSheetResolver = () => null;
  plugin.applySheetUpdates = async () => {};
  plugin.removeSyncStateKeys = () => {};
  plugin.saveLarkSyncState = async () => {};
  plugin.tryBootstrapPreciseSyncState = async () => undefined;
  plugin.persistDocumentState = async () => {};

  note.content = "# 说明\n\n![[图纸/系统架构图.excalidraw.md]]\n\n参考 [[普通笔记]]。\n";
  const content = await plugin.readNoteForLark(note);

  // 目录发布会先用 folder linkMap 改写内链：PNG 嵌入不应被改成 cite
  const folderLinkMap = new Map();
  plugin.addLinkAliases(folderLinkMap, "图纸", drawing, {
    token: "DRAWING_DOC",
    url: "https://x.feishu.cn/docx/DRAWING_DOC",
  });
  const folderContent = plugin.rewriteInternalLinks(content, folderLinkMap, note);
  assert.match(folderContent, /!\[\[系统架构图\.oblark-excalidraw-[0-9a-f]{12}\.png\]\]/);
  assert.ok(!folderContent.includes("<cite"), "目录发布的 linkMap 不会把 PNG 嵌入替换成 cite");

  const result = await plugin.updateLarkDocument("PARENT_DOC", folderContent, {
    path: note.path,
    strategy: "overwrite",
    stateKeys: [],
  });
  assert.equal(result.token, "PARENT_DOC");
  const xml = harness.writtenXml.filter((entry) => entry.command === "+update").at(-1).xml;
  assert.match(xml, /<img src="MEDIA_TOKEN_\d+" name="系统架构图\.oblark-excalidraw-[0-9a-f]{12}\.png" width="1200" height="900"\/>/);
  assert.ok(!/\[图片: /.test(xml));
  const uploads = harness.cliCalls.filter((args) => args[1] === "+media-upload");
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0][uploads[0].indexOf("--doc-id") + 1], "PARENT_DOC", "图片必须上传到父文档");

  await fsp.rm(harness.vaultDirectory, { force: true, recursive: true });
});

test("导出失败时退回子文档 cite，且不会把源文本写入正文", async () => {
  const harness = await buildHarness();
  const { plugin, note } = harness;
  globalThis.ExcalidrawAutomate = {
    getAPI: () => ({
      async createPNG() {
        throw new Error("render failed");
      },
      destroy() {},
    }),
  };
  note.content = "# 说明\n\n[[图纸/系统架构图.excalidraw.md]]\n";

  const content = await plugin.readNoteForLark(note);
  assert.equal(content.includes("[[图纸/系统架构图.excalidraw.md]]"), true);
  await plugin.createLarkDocument(note, content, { kind: "wiki", token: "PARENT_SPACE" }, new Set());

  // 绘图子文档被创建（父文档 + 绘图占位子文档共两次 +create），父文档以 cite 引用它
  const creates = harness.cliCalls.filter((args) => args[1] === "+create");
  assert.equal(creates.length, 2);
  const xml = harness.writtenXml.at(-1).xml;
  assert.match(xml, /<cite type="doc" doc-id="[A-Za-z0-9_]+"><\/cite>/);
  assert.ok(!/excalidraw-source/.test(xml));
  assert.equal(harness.cliCalls.filter((args) => args[1] === "+media-upload").length, 0, "导出失败不得上传任何素材");
  assert.ok(notices.some((message) => message.includes("Excalidraw 预览生成失败")), "失败必须提示用户");

  await fsp.rm(harness.vaultDirectory, { force: true, recursive: true });
});
