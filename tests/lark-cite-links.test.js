"use strict";

/**
 * 飞书文档链接 → 文档提及（cite）回归测试。
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const cite = require("../lark-cite-links.js");

const DOCX_TOKEN = "H0qWdSKNLoCQgMxJ42IcqX5QnKh";
const WIKI_TOKEN = "Wikcn1234567890abc";
const DOCX_URL = `https://xiaopeng.feishu.cn/docx/${DOCX_TOKEN}`;
const WIKI_URL = `https://xiaopeng.feishu.cn/wiki/${WIKI_TOKEN}`;

function createPlugin(options = {}) {
  return {
    settings: {},
    cliCalls: [],
    saveCount: 0,
    async saveSettings() {
      this.saveCount += 1;
    },
    async runLarkCli(args) {
      this.cliCalls.push(args);
      if (options.inspectError) throw new Error("permission denied");
      return options.inspectResponse ?? { data: {} };
    },
    getBinding: () => options.binding ?? null,
  };
}

const noteFile = { path: "笔记/说明.md" };

/* ---------- URL 解析 ---------- */

test("parseLarkDocUrl 识别 docx / wiki，其它类型标记为 other", () => {
  assert.deepEqual(cite.parseLarkDocUrl(`${DOCX_URL}?from=from_copylink`), {
    kind: "docx",
    token: DOCX_TOKEN,
    canonicalUrl: DOCX_URL,
  });
  assert.equal(cite.parseLarkDocUrl(WIKI_URL).kind, "wiki");
  assert.equal(cite.parseLarkDocUrl("https://x.feishu.cn/sheets/shtcnAbcdefghij").kind, "other");
  assert.equal(cite.parseLarkDocUrl("https://x.feishu.cn/base/bascnAbcdefghij").kind, "other");
  assert.equal(cite.parseLarkDocUrl("https://x.feishu.cn/wiki/space/7123456789").kind, "other");
  assert.equal(cite.parseLarkDocUrl("https://x.feishu.cn/drive/folder/fldcnAbcdefghij").kind, "other");
});

test("parseLarkDocUrl 只认飞书系域名与合法 token", () => {
  assert.equal(cite.parseLarkDocUrl("https://github.com/docx/H0qWdSKNLoCQgMxJ42IcqX5QnKh"), null);
  assert.equal(cite.parseLarkDocUrl("https://notfeishu.cn.evil.com/docx/H0qWdSKNLoCQgMxJ42Ic"), null);
  assert.equal(cite.parseLarkDocUrl("not a url"), null);
  assert.equal(cite.parseLarkDocUrl("https://x.feishu.cn/docx/short").kind, "other", "过短的 token 不当作文档");
  for (const host of ["a.larksuite.com", "a.larkoffice.com", "feishu.cn"]) {
    assert.equal(cite.parseLarkDocUrl(`https://${host}/docx/${DOCX_TOKEN}`).kind, "docx", host);
  }
});

/* ---------- 链接收集 ---------- */

test("collectLarkLinks 覆盖裸链接 / markdown 链接 / 尖括号链接，并跳过代码与属性", () => {
  const markdown = [
    `裸链接 ${DOCX_URL} 结束`,
    `[项目方案](${DOCX_URL})`,
    `<${DOCX_URL}>`,
    `句尾标点 ${DOCX_URL}。`,
    `英文句号 ${DOCX_URL}.`,
    `\`${DOCX_URL}\``,
    "```",
    DOCX_URL,
    "```",
    `![封面](${DOCX_URL})`,
    `<a href="${DOCX_URL}">x</a>`,
    `[ref]: ${DOCX_URL}`,
    "https://github.com/a/b",
  ].join("\n");

  const links = cite.collectLarkLinks(markdown);
  assert.deepEqual(
    links.map((link) => link.text),
    [DOCX_URL, `[项目方案](${DOCX_URL})`, `<${DOCX_URL}>`, DOCX_URL, DOCX_URL],
  );
  assert.equal(links[3].trailing, "", "中文句号本来就不会被吃进链接");
  assert.equal(links[4].trailing, ".", "英文句号要还回正文");
});

/* ---------- docx 链接改写 ---------- */

test("docx 链接改写为文档提及，非飞书链接保持原样", async () => {
  const plugin = createPlugin();
  const markdown = [
    `见 ${DOCX_URL} 与 [项目方案](${DOCX_URL})。`,
    `外部：[GitHub](https://github.com/a/b) https://example.com/x`,
  ].join("\n");

  const result = await cite.convertLarkLinksToCites(plugin, markdown, noteFile);
  const tag = `<cite type="doc" doc-id="${DOCX_TOKEN}"></cite>`;
  assert.equal(result, [`见 ${tag} 与 ${tag}。`, "外部：[GitHub](https://github.com/a/b) https://example.com/x"].join("\n"));
  assert.equal(plugin.cliCalls.length, 0, "docx 链接不需要任何 API 调用");
});

test("句尾标点与代码块内容不受影响", async () => {
  const plugin = createPlugin();
  const markdown = [`详见 ${DOCX_URL}。`, "```", DOCX_URL, "```", `行内 \`${DOCX_URL}\` 保留`].join("\n");
  const result = await cite.convertLarkLinksToCites(plugin, markdown, noteFile);
  assert.match(result, new RegExp(`详见 <cite type="doc" doc-id="${DOCX_TOKEN}"></cite>。`));
  assert.equal(result.split(DOCX_URL).length - 1, 2, "代码块与行内代码里的链接原样保留");
});

test("引用自身文档时保留原始链接", async () => {
  const plugin = createPlugin({ binding: { token: DOCX_TOKEN, url: DOCX_URL } });
  const result = await cite.convertLarkLinksToCites(plugin, `本文 ${DOCX_URL}`, noteFile);
  assert.equal(result, `本文 ${DOCX_URL}`);
});

/* ---------- wiki 链接解包 ---------- */

test("wiki 链接经 drive +inspect 解包成底层 docx token，并缓存结果", async () => {
  const plugin = createPlugin({
    inspectResponse: { data: { wiki_node: { obj_token: DOCX_TOKEN, obj_type: "docx" }, type: "docx" } },
  });

  const first = await cite.convertLarkLinksToCites(plugin, `方案 ${WIKI_URL}?from=copy`, noteFile);
  assert.equal(first, `方案 <cite type="doc" doc-id="${DOCX_TOKEN}"></cite>`);
  assert.equal(plugin.cliCalls.length, 1);
  assert.deepEqual(plugin.cliCalls[0], ["drive", "+inspect", "--as", "user", "--url", WIKI_URL]);
  assert.deepEqual(plugin.settings[cite.WIKI_CACHE_KEY][WIKI_TOKEN].token, DOCX_TOKEN);

  const second = await cite.convertLarkLinksToCites(plugin, `再引用 ${WIKI_URL}`, noteFile);
  assert.match(second, /<cite type="doc" doc-id=/);
  assert.equal(plugin.cliCalls.length, 1, "命中缓存不再调用 API");
});

test("wiki 底层不是 docx 时保留原始链接", async () => {
  const plugin = createPlugin({
    inspectResponse: { data: { wiki_node: { obj_token: "shtcnAbcdefghij", obj_type: "sheet" } } },
  });
  const result = await cite.convertLarkLinksToCites(plugin, `表格 ${WIKI_URL}`, noteFile);
  assert.equal(result, `表格 ${WIKI_URL}`);
});

test("wiki 解析失败保留原始链接，且不会每次都重试", async () => {
  const plugin = createPlugin({ inspectError: true });
  const first = await cite.convertLarkLinksToCites(plugin, `失败 ${WIKI_URL}`, noteFile);
  assert.equal(first, `失败 ${WIKI_URL}`);
  assert.equal(plugin.cliCalls.length, 1);
  const second = await cite.convertLarkLinksToCites(plugin, `再来 ${WIKI_URL}`, noteFile);
  assert.equal(second, `再来 ${WIKI_URL}`);
  assert.equal(plugin.cliCalls.length, 1, "失败结果进入负缓存");
});

test("没有链接的正文原样返回", async () => {
  const plugin = createPlugin();
  const markdown = "# 标题\n\n普通正文，没有任何链接。\n";
  assert.equal(await cite.convertLarkLinksToCites(plugin, markdown, noteFile), markdown);
});

test("buildCiteTag 对 token 做 XML 转义", () => {
  assert.equal(cite.buildCiteTag('a"b'), '<cite type="doc" doc-id="a&quot;b"></cite>');
  assert.equal(cite.escapeXmlAttribute("a&<>\"b"), "a&amp;&lt;&gt;&quot;b");
});

test("下拉还原出的 \u{1F4C4} [标题](URL) 再推送时前缀一起收掉", async () => {
  const plugin = createPlugin();
  const result = await cite.convertLarkLinksToCites(plugin, `见 \u{1F4C4} [项目方案](${DOCX_URL}) 结束`, noteFile);
  assert.equal(result, `见 <cite type="doc" doc-id="${DOCX_TOKEN}"></cite> 结束`);
});

/* ---------- 稳定性加固 ---------- */

test("同一个 wiki 链接并发解析只调一次 API", async () => {
  const plugin = createPlugin({
    inspectResponse: { data: { wiki_node: { obj_token: DOCX_TOKEN, obj_type: "docx" } } },
  });
  const notes = [`甲 ${WIKI_URL}`, `乙 ${WIKI_URL}`, `丙 ${WIKI_URL}`];
  const results = await Promise.all(notes.map((md) => cite.convertLarkLinksToCites(plugin, md, noteFile)));
  for (const result of results) assert.match(result, new RegExp(`<cite type="doc" doc-id="${DOCX_TOKEN}"></cite>`));
  assert.equal(plugin.cliCalls.length, 1, "并发时不应重复调用 drive +inspect");
});

test("wiki 缓存超上限时淘汰最旧条目，不会无限膨胀", async () => {
  const plugin = createPlugin({
    inspectResponse: { data: { wiki_node: { obj_token: DOCX_TOKEN, obj_type: "docx" } } },
  });
  const cache = {};
  for (let index = 0; index < 520; index += 1) {
    cache[`Wikcnfill${String(index).padStart(6, "0")}`] = { token: "x".repeat(12), type: "docx", checkedAt: index };
  }
  plugin.settings[cite.WIKI_CACHE_KEY] = cache;

  await cite.convertLarkLinksToCites(plugin, `新链接 ${WIKI_URL}`, noteFile);
  const stored = plugin.settings[cite.WIKI_CACHE_KEY];
  assert.equal(Object.keys(stored).length, 500);
  assert.equal(stored.Wikcnfill000000, undefined, "最旧的条目被淘汰");
  assert.equal(stored[WIKI_TOKEN].token, DOCX_TOKEN, "新条目保留");
});

test("设置写盘失败时链接改写仍然生效", async () => {
  const plugin = createPlugin({
    inspectResponse: { data: { wiki_node: { obj_token: DOCX_TOKEN, obj_type: "docx" } } },
  });
  plugin.saveSettings = async () => {
    throw new Error("disk full");
  };
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    const result = await cite.convertLarkLinksToCites(plugin, `方案 ${WIKI_URL}`, noteFile);
    assert.match(result, new RegExp(`<cite type="doc" doc-id="${DOCX_TOKEN}"></cite>`));
    assert.ok(warnings.some((line) => line.includes("写入 wiki token 缓存失败")));
  } finally {
    console.warn = originalWarn;
  }
});
