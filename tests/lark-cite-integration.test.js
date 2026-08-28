"use strict";

/**
 * 端到端（本地）：加载真实 main.js，验证飞书链接最终落进 Docx XML 的形态。
 * 不访问飞书，runLarkCli 为桩，但 markdown→XML 全部走 main.js 真实实现。
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

const DOCX_TOKEN = "H0qWdSKNLoCQgMxJ42IcqX5QnKh";
const WIKI_TOKEN = "Wikcn1234567890abc";
const WIKI_DOCX_TOKEN = "Doxcn9876543210zyx";
const DOCX_URL = `https://xiaopeng.feishu.cn/docx/${DOCX_TOKEN}`;
const WIKI_URL = `https://xiaopeng.feishu.cn/wiki/${WIKI_TOKEN}`;

let vaultDirectory;

test.before(async () => {
  vaultDirectory = await fsp.mkdtemp(path.join(os.tmpdir(), "oblark-cite-"));
  await new Promise((resolve) => setTimeout(resolve, 30));
});

test.after(async () => {
  Module._load = originalLoad;
  await fsp.rm(vaultDirectory, { force: true, recursive: true });
});

async function toDocxXml(markdown) {
  const note = new TFile();
  Object.assign(note, {
    path: "note.md",
    name: "note.md",
    basename: "note",
    extension: "md",
    content: markdown,
    stat: { mtime: 1, size: 0 },
  });
  const files = new Map([[note.path, note]]);

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
  const cliCalls = [];
  plugin.runLarkCli = async (args, options) => {
    cliCalls.push(args);
    const contentIndex = args.indexOf("--content");
    if (contentIndex >= 0 && String(args[contentIndex + 1]).startsWith("@")) {
      written.push(fs.readFileSync(path.join(options.cwd, args[contentIndex + 1].slice(1)), "utf8"));
    }
    if (args[0] === "drive" && args[1] === "+inspect") {
      return { data: { type: "docx", token: WIKI_DOCX_TOKEN, wiki_node: { obj_token: WIKI_DOCX_TOKEN, obj_type: "docx" } } };
    }
    if (args[1] === "+create") {
      return { data: { document: { document_id: "DOC", url: "https://x.feishu.cn/docx/DOC" } } };
    }
    return { data: {} };
  };
  plugin.validateRemoteBinding = async () => true;
  plugin.writeBinding = async () => {};
  plugin.saveSettings = async () => {};
  plugin.resolveRemoteRootParent = async () => ({ token: "SPACE" });

  const content = await plugin.readNoteForLark(note);
  await plugin.createLarkDocument(note, content, { token: "SPACE" }, new Set());
  return { xml: written.at(-1).replace(/^<title>[^<]*<\/title>\n?/, ""), cliCalls, settings: plugin.settings };
}

test("扩展已挂载到真实插件类", () => {
  assert.equal(mainModule.default.prototype.__larkCiteLinksInstalled, true);
  assert.equal(mainModule.default.prototype.__excalidrawPdfSyncInstalled, true, "两个扩展共存");
  assert.match(mainModule.default.prototype.readNoteForLark.toString(), /convertLarkLinksToCites/);
});

test("段落 / 列表 / 表格里的飞书文档链接都渲染成文档提及", async () => {
  const { xml } = await toDocxXml([
    "# 说明",
    "",
    `正文引用 ${DOCX_URL} 结束。`,
    "",
    `- 列表项 [项目方案](${DOCX_URL})`,
    "",
    "| 名称 | 链接 |",
    "|---|---|",
    `| 方案 | ${DOCX_URL} |`,
    "",
    `> 引用块 ${DOCX_URL}`,
    "",
    "外部链接 [GitHub](https://github.com/a/b)",
    "",
  ].join("\n"));

  const tag = `<cite type="doc" doc-id="${DOCX_TOKEN}"></cite>`;
  assert.equal(xml.split(tag).length - 1, 4, `段落/列表/表格/引用块共 4 处都应是 cite，实际:\n${xml}`);
  assert.match(xml, new RegExp(`<p>正文引用 ${tag} 结束。</p>`));
  assert.match(xml, new RegExp(`<li>列表项 ${tag}</li>`));
  assert.match(xml, new RegExp(`<td>${tag}</td>`));
  assert.match(xml, new RegExp(`<blockquote><p>引用块 ${tag}</p></blockquote>`));
  assert.match(xml, /<a href="https:\/\/github\.com\/a\/b">GitHub<\/a>/, "非飞书链接仍是普通超链接");
  assert.ok(!xml.includes(DOCX_URL), "正文里不应再残留飞书 URL 纯文本");
});

test("wiki 链接解包成底层 docx token 后再渲染", async () => {
  const { xml, cliCalls, settings } = await toDocxXml(`知识库文档：${WIKI_URL}?from=from_copylink\n`);
  assert.match(xml, new RegExp(`<cite type="doc" doc-id="${WIKI_DOCX_TOKEN}"></cite>`));
  const inspects = cliCalls.filter((args) => args[0] === "drive" && args[1] === "+inspect");
  assert.equal(inspects.length, 1);
  assert.deepEqual(inspects[0], ["drive", "+inspect", "--as", "user", "--url", WIKI_URL]);
  assert.equal(settings.larkWikiObjectTokenCache[WIKI_TOKEN].token, WIKI_DOCX_TOKEN);
});

test("代码块里的飞书链接保持原样", async () => {
  const { xml } = await toDocxXml(["```", DOCX_URL, "```", ""].join("\n"));
  assert.match(xml, /<pre lang=""><code>https:\/\/xiaopeng\.feishu\.cn\/docx\//);
  assert.ok(!xml.includes("<cite"));
});
