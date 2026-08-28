"use strict";

/**
 * 兜底路径：拿不到 main.js 内部媒体解析器时（例如用户只更新了 excalidraw-pdf-sync.js），
 * 不允许把 wikilink 改写成无法解析的图片嵌入，必须保持原文，退回旧的子文档链接行为。
 * 单独一个测试文件，保证模块级状态是全新的。
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const sync = require("../excalidraw-pdf-sync.js");

class TFile {
  constructor(filePath, content, frontmatter) {
    this.path = filePath;
    this.name = filePath.slice(filePath.lastIndexOf("/") + 1);
    this.basename = this.name.replace(/\.md$/i, "");
    this.content = content;
    this.frontmatter = frontmatter;
    this.stat = { mtime: 1 };
  }
}

class BarePlugin {
  constructor(files) {
    this.settings = {};
    this.files = new Map(files.map((file) => [file.path, file]));
    this.app = {
      plugins: { getPlugin: () => ({}) },
      metadataCache: {
        getFileCache: (file) => (file.frontmatter ? { frontmatter: file.frontmatter } : null),
        getFirstLinkpathDest: () => null,
      },
      vault: {
        getAbstractFileByPath: (target) => this.files.get(target) || null,
        cachedRead: async (file) => file.content,
      },
    };
  }
  resolveWikiLinkTargetFile(target) {
    return this.files.get(target) || this.files.get(`${target}.md`) || null;
  }
  sanitizeFileName(name) {
    return name;
  }
  async readNoteForLark(file) {
    return file.content;
  }
  getBinding() {
    return null;
  }
  shouldWriteBinding() {
    return true;
  }
  async processWikiLinksForSubDocuments() {
    return { linkMap: new Map() };
  }
  async createLarkDocument() {
    return {};
  }
  async updateLarkDocument() {
    return {};
  }
  async syncFileInternal() {
    return {};
  }
}

test("没有媒体解析器时不改写正文", async () => {
  const drawing = new TFile("图纸/架构.excalidraw.md", "src", { "excalidraw-plugin": "parsed" });
  const note = new TFile("说明.md", "![[图纸/架构.excalidraw.md]]");
  sync.installExcalidrawPdfSync(BarePlugin, undefined);
  const plugin = new BarePlugin([drawing, note]);

  let created = false;
  globalThis.ExcalidrawAutomate = {
    getAPI: () => ({
      async createPNG() {
        created = true;
        return new Uint8Array(0);
      },
      destroy() {},
    }),
  };

  const content = await plugin.readNoteForLark(note);
  assert.equal(content, "![[图纸/架构.excalidraw.md]]", "正文保持原样");
  assert.equal(created, false, "不应触发导出");
});
