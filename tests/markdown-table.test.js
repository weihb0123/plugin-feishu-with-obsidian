"use strict";

/**
 * Markdown 表格识别回归测试（跑真实 main.js 的 markdown→Docx XML 转换器）。
 *
 * 背景：含竖线的行（`![[img.png|500]]`、`[x](url?a=1|2)`、`$a|b$` 等）如果紧跟
 * Obsidian 分割线 `---`，曾被误判成表格：图片被渲染成表格，或整行被静默丢弃。
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");

class TFile {}
class TFolder {}
const obsidianStub = {
  Plugin: class {},
  PluginSettingTab: class {},
  Modal: class {},
  Notice: class { hide() {} },
  Setting: class {
    setName() { return this; }
    setDesc() { return this; }
    setHeading() { return this; }
  },
  TFile,
  TFolder,
  normalizePath: (value) => value,
};

const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === "obsidian") return obsidianStub;
  return originalLoad.call(this, request, ...rest);
};
const mainModule = require("../main.js");

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

function makeFile(filePath) {
  const file = new TFile();
  file.path = filePath;
  file.name = filePath.slice(filePath.lastIndexOf("/") + 1);
  file.basename = file.name.replace(/\.[^.]+$/, "");
  file.extension = filePath.slice(filePath.lastIndexOf(".") + 1);
  file.content = "";
  file.stat = { mtime: 1, size: 0 };
  return file;
}

let vaultDirectory;

test.before(async () => {
  vaultDirectory = await fsp.mkdtemp(path.join(os.tmpdir(), "oblark-table-"));
  await fsp.writeFile(path.join(vaultDirectory, "photo.png"), pngBytes(64, 48));
  await new Promise((resolve) => setTimeout(resolve, 30));
});

test.after(async () => {
  Module._load = originalLoad;
  await fsp.rm(vaultDirectory, { force: true, recursive: true });
});

/** 用真实转换链路把 markdown 变成父文档 XML */
async function toDocxXml(markdown) {
  const note = makeFile("note.md");
  const photo = makeFile("photo.png");
  note.content = markdown;
  const files = new Map([[note.path, note], [photo.path, photo]]);

  const plugin = Object.create(mainModule.default.prototype);
  plugin.settings = {
    language: "zh-CN",
    titleSource: "file-name",
    headingAutoNumber: false,
    frontmatterStripKeys: [],
    updateFrontmatter: false,
    syncStrategy: "auto",
  };
  plugin.app = {
    plugins: { getPlugin: () => null },
    metadataCache: { getFileCache: () => null, getFirstLinkpathDest: () => null },
    vault: {
      adapter: { basePath: vaultDirectory },
      getAbstractFileByPath: (target) => files.get(target) || null,
      getFiles: () => Array.from(files.values()),
      getMarkdownFiles: () => Array.from(files.values()),
      cachedRead: async (file) => file.content,
      read: async (file) => file.content,
    },
  };
  const written = [];
  let mediaCounter = 0;
  plugin.runLarkCli = async (args, options) => {
    const contentIndex = args.indexOf("--content");
    if (contentIndex >= 0 && String(args[contentIndex + 1]).startsWith("@")) {
      written.push(fs.readFileSync(path.join(options.cwd, args[contentIndex + 1].slice(1)), "utf8"));
    }
    if (args[1] === "+create") {
      return { data: { document: { document_id: "DOC", url: "https://x.feishu.cn/docx/DOC" } } };
    }
    if (args[1] === "+fetch") {
      return { data: { document: { document_id: "DOC", content: '<p id="b1">s</p>' } } };
    }
    if (args[1] === "+media-upload") {
      mediaCounter += 1;
      return { data: { file_token: `TK${mediaCounter}`, size: 1 } };
    }
    return { data: {} };
  };
  plugin.validateRemoteBinding = async () => true;
  plugin.writeBinding = async () => {};
  plugin.saveSettings = async () => {};
  plugin.resolveRemoteRootParent = async () => ({ token: "SPACE" });

  const content = await plugin.readNoteForLark(note);
  await plugin.createLarkDocument(note, content, { token: "SPACE" }, new Set());
  return written.at(-1).replace(/^<title>[^<]*<\/title>\n?/, "");
}

test("带尺寸的图片紧跟分割线不会变成表格", async () => {
  const xml = await toDocxXml("![[photo.png|500]]\n---\n");
  assert.match(xml, /<img src="TK1" name="photo\.png" width="64" height="48"\/>/);
  assert.match(xml, /<hr\/>/);
  assert.ok(!/<table|<td/.test(xml));
});

test("含竖线的 md 链接紧跟分割线不会丢内容", async () => {
  const xml = await toDocxXml("[链接](https://x/?a=1|2)\n---\n");
  assert.match(xml, /<a href="https:\/\/x\/\?a=1\|2">链接<\/a>/);
  assert.ok(!/<table|<td/.test(xml));
});

test("含竖线的行内公式紧跟分割线不会丢内容", async () => {
  const xml = await toDocxXml("$a|b$\n---\n");
  assert.match(xml, /<latex>a\|b<\/latex>/);
  assert.ok(!/<table|<td/.test(xml));
});

test("含竖线的行内代码紧跟分割线不会丢内容", async () => {
  const xml = await toDocxXml("`a|b`\n---\n");
  assert.match(xml, /<code>a\|b<\/code>/);
  assert.ok(!/<table|<td/.test(xml));
});

test("普通表格仍然正常渲染", async () => {
  const xml = await toDocxXml("| A | B |\n|---|---|\n| 1 | 2 |\n");
  assert.match(xml, /<table>/);
  assert.match(xml, /<th background-color="light-gray">A<\/th>/);
  assert.match(xml, /<td>1<\/td>[\s\S]*<td>2<\/td>/);
});

test("对齐语法与无外侧竖线的分隔行仍被识别", async () => {
  const xml = await toDocxXml("A | B\n:--- | ---:\n1 | 2\n");
  assert.match(xml, /<table>/);
  assert.match(xml, /<th background-color="light-gray">A<\/th>/);
});

test("表格单元格里的带尺寸图片不会把列切错", async () => {
  const xml = await toDocxXml("| A | B |\n|---|---|\n| ![[photo.png|300]] | 2 |\n");
  assert.match(xml, /<td><p><img src="TK1" name="photo\.png"[^>]*\/><\/p><\/td>\s*<td>2<\/td>/);
});

test("单元格里的 [[链接|别名]] 不会被当成列分隔", async () => {
  const xml = await toDocxXml("| [[某笔记|别名]] | B |\n|---|---|\n| 1 | 2 |\n");
  const headerCells = xml.match(/<th[^>]*>.*?<\/th>/g) || [];
  assert.equal(headerCells.length, 2);
});

test("方括号未配对时整张表不会退化成段落", async () => {
  const xml = await toDocxXml("| a [[ b | c |\n|---|---|\n| 1 | 2 |\n");
  assert.match(xml, /<table>/);
  const headerCells = xml.match(/<th[^>]*>.*?<\/th>/g) || [];
  assert.equal(headerCells.length, 2);
});

test("下一行不是合法分隔行时不当作表格", async () => {
  const xml = await toDocxXml("A | B\n| --- | 说明 |\n");
  assert.ok(!/<table|<td/.test(xml), `不应识别为表格：${xml}`);
  assert.match(xml, /说明/, "内容不得被丢弃");
});
