"use strict";

/**
 * 飞书文档链接 → 文档提及（cite）扩展。
 *
 * 背景：飞书的"智能粘贴"是客户端剪贴板事件，API 推送不会触发它，
 * 所以正文里的飞书文档 URL 只会以纯文本 / 普通超链接落进文档，没有缩略图预览。
 * 本扩展在推送前把飞书云文档链接改写成 lark-cli XML 的
 *   <cite type="doc" doc-id="DOC_TOKEN"></cite>
 * 由飞书渲染成文档提及（显示真实标题、hover 出预览）。
 *
 * 这个 XML 形态与主插件已有的 wikilink→cite 输出完全一致，属于已验证可用的形态。
 */

const CITE_TYPE_DOC = "doc";
/** 只有这些底层类型确认可以用 <cite type="doc" doc-id> 表达 */
const CITE_READY_OBJECT_TYPES = new Set(["docx"]);
const LARK_HOST_SUFFIXES = ["feishu.cn", "feishu.net", "larksuite.com", "larkoffice.com"];
const WIKI_CACHE_KEY = "larkWikiObjectTokenCache";
/** 缓存条目上限，超出后淘汰最旧的（纯缓存，淘汰只影响一次多余的 API 调用） */
const WIKI_CACHE_LIMIT = 500;
/** 解析失败后的重试间隔，避免每次同步都打一次失败请求 */
const WIKI_NEGATIVE_RETRY_MS = 24 * 60 * 60 * 1000;
const TOKEN_PATTERN = /^[A-Za-z0-9]{10,}$/;

/**
 * 依次匹配：markdown 链接 / <尖括号自动链接> / 裸链接。
 * 交替顺序保证 [文本](URL) 里的 URL 不会被后面的裸链接分支重复命中。
 */
const LINK_PATTERN = new RegExp(
  [
    "(?<!!)\\[([^\\]]*)\\]\\(\\s*(https?://[^\\s)]+?)\\s*(?:\"[^\"]*\")?\\s*\\)",
    "<(https?://[^\\s>]+)>",
    "(https?://[^\\s<>()\\[\\]\"'`，。；、）】]+)",
  ].join("|"),
  "g",
);
const TRAILING_PUNCTUATION = /[.,;:!?、，。；！？）】]+$/;
/** 下拉（飞书 → 本地）时 cite 会被还原成 "📄 [标题](URL)" */
const PULLED_DOC_PREFIX = "\u{1F4C4} ";

let collectCodeRanges = null;
/** 进行中的 wiki 解包任务，避免并发重复调用 */
const pendingWikiLookups = new Map();
try {
  ({ collectCodeRanges } = require("./excalidraw-pdf-sync.js"));
} catch {
  /* 下面统一降级处理 */
}
if (typeof collectCodeRanges !== "function") {
  console.warn("[ObLark Sync] 未取到代码块扫描器，飞书链接改写将不跳过代码块");
  collectCodeRanges = () => [];
}

function escapeXmlAttribute(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}

function isInsideRanges(ranges, index) {
  for (const [start, end] of ranges) {
    if (index >= start && index < end) return true;
  }
  return false;
}

function isLarkHost(hostname) {
  const host = hostname.toLowerCase();
  return LARK_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/**
 * 解析飞书云文档 URL。
 * 返回 { kind, token, canonicalUrl }；不是飞书云文档链接时返回 null。
 * kind: docx | wiki | other（other 表示是飞书链接但不是可提及的文档）
 */
function parseLarkDocUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (!isLarkHost(url.hostname)) return null;

  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length < 2) return null;
  const [first, second] = segments;
  const canonicalUrl = `${url.origin}/${segments.join("/")}`;

  if (first === "docx" && TOKEN_PATTERN.test(second)) {
    return { kind: "docx", token: second, canonicalUrl };
  }
  // /wiki/space/123 是空间首页，不是文档
  if (first === "wiki" && second !== "space" && TOKEN_PATTERN.test(second)) {
    return { kind: "wiki", token: second, canonicalUrl };
  }
  return { kind: "other", token: TOKEN_PATTERN.test(second) ? second : "", canonicalUrl };
}

function readWikiCache(plugin) {
  const settings = plugin.settings || (plugin.settings = {});
  if (!settings[WIKI_CACHE_KEY] || typeof settings[WIKI_CACHE_KEY] !== "object") {
    settings[WIKI_CACHE_KEY] = {};
  }
  return settings[WIKI_CACHE_KEY];
}

/** 纯缓存，超上限就淘汰最旧的；被淘汰的条目下次只是多调一次 API，无副作用 */
function pruneWikiCache(cache) {
  const keys = Object.keys(cache);
  if (keys.length <= WIKI_CACHE_LIMIT) return;
  keys
    .sort((a, b) => (cache[a]?.checkedAt || 0) - (cache[b]?.checkedAt || 0))
    .slice(0, keys.length - WIKI_CACHE_LIMIT)
    .forEach((key) => delete cache[key]);
}

/** wiki 节点 token 不是底层文档 token，必须用 drive +inspect 解包（结果长期缓存） */
async function resolveWikiObject(plugin, wikiToken, canonicalUrl) {
  const cache = readWikiCache(plugin);
  const cached = cache[wikiToken];
  if (cached?.token) return { token: cached.token, type: cached.type };
  if (cached && Date.now() - (cached.checkedAt || 0) < WIKI_NEGATIVE_RETRY_MS) return null;

  // 目录发布时同一个 wiki 链接可能出现在多篇笔记里，并发时只查一次
  const inflight = pendingWikiLookups.get(wikiToken);
  if (inflight) return inflight;

  const task = (async () => {
    let resolved = null;
    try {
      const response = await plugin.runLarkCli(["drive", "+inspect", "--as", "user", "--url", canonicalUrl]);
      const node = response?.data?.wiki_node || response?.data?.node;
      const token = node?.obj_token || response?.data?.token;
      const type = node?.obj_type || response?.data?.type;
      if (token && type) resolved = { token, type };
    } catch (error) {
      console.warn(`[ObLark Sync] wiki 链接解析失败，保留原始链接：${canonicalUrl}（${describeError(error)}）`);
    }

    cache[wikiToken] = resolved
      ? { token: resolved.token, type: resolved.type, checkedAt: Date.now() }
      : { checkedAt: Date.now() };
    pruneWikiCache(cache);
    try {
      await plugin.saveSettings();
    } catch (error) {
      console.warn(`[ObLark Sync] 写入 wiki token 缓存失败：${describeError(error)}`);
    }
    return resolved;
  })().finally(() => {
    if (pendingWikiLookups.get(wikiToken) === task) pendingWikiLookups.delete(wikiToken);
  });

  pendingWikiLookups.set(wikiToken, task);
  return task;
}

function buildCiteTag(token) {
  return `<cite type="${CITE_TYPE_DOC}" doc-id="${escapeXmlAttribute(token)}"></cite>`;
}

/** 决定某个飞书链接该不该改写成 cite；不确定就返回 null（保留原文） */
async function resolveCiteTag(plugin, parsed, selfToken) {
  if (parsed.kind === "docx") {
    return parsed.token === selfToken ? null : buildCiteTag(parsed.token);
  }
  if (parsed.kind !== "wiki") return null;

  const resolved = await resolveWikiObject(plugin, parsed.token, parsed.canonicalUrl);
  if (!resolved) return null;
  if (!CITE_READY_OBJECT_TYPES.has(String(resolved.type))) {
    console.info(
      `[ObLark Sync] wiki 链接底层类型为 ${resolved.type}，暂不改写为文档提及：${parsed.canonicalUrl}`,
    );
    return null;
  }
  return resolved.token === selfToken ? null : buildCiteTag(resolved.token);
}

function readSelfToken(plugin, file) {
  try {
    const binding = plugin.getBinding?.(file);
    if (!binding) return "";
    if (binding.token && TOKEN_PATTERN.test(binding.token)) return binding.token;
    return String(binding.url || "").match(/\/(?:docx|wiki)\/([A-Za-z0-9]+)/)?.[1] || "";
  } catch {
    return "";
  }
}

/** 判断裸链接是否处在 markdown 链接目标位置 `](URL)` 里 */
function isMarkdownLinkTarget(markdown, index) {
  let cursor = index - 1;
  while (cursor >= 0 && (markdown[cursor] === " " || markdown[cursor] === "\t")) cursor -= 1;
  return cursor >= 1 && markdown[cursor] === "(" && markdown[cursor - 1] === "]";
}

/** 判断裸链接是否处在引用式链接定义 `[ref]: URL` 里 */
function isLinkDefinition(markdown, index) {
  const lineStart = markdown.lastIndexOf("\n", index - 1) + 1;
  return /^\s{0,3}\[[^\]]+\]:\s*$/.test(markdown.slice(lineStart, index));
}

/** 收集正文中所有需要改写的链接（跳过代码块 / 行内代码 / HTML 属性里的 URL） */
function collectLarkLinks(markdown) {
  const ranges = collectCodeRanges(markdown);
  const matches = [];
  const pattern = new RegExp(LINK_PATTERN.source, "g");
  let match;

  while ((match = pattern.exec(markdown)) !== null) {
    if (isInsideRanges(ranges, match.index)) continue;
    const previous = match.index > 0 ? markdown[match.index - 1] : "";
    if (previous === '"' || previous === "'" || previous === "=") continue;

    const isMarkdownLink = match[2] !== undefined;
    const isBareUrl = match[4] !== undefined;
    if (isBareUrl && (isMarkdownLinkTarget(markdown, match.index) || isLinkDefinition(markdown, match.index))) {
      continue;
    }

    let text = match[0];
    let index = match.index;
    let rawUrl = match[2] ?? match[3] ?? match[4] ?? "";
    let trailing = "";
    if (isBareUrl) {
      // 裸链接：把结尾的标点还回正文
      const trimmed = rawUrl.replace(TRAILING_PUNCTUATION, "");
      trailing = rawUrl.slice(trimmed.length);
      rawUrl = trimmed;
      text = text.slice(0, text.length - trailing.length);
    } else if (isMarkdownLink && markdown.slice(index - PULLED_DOC_PREFIX.length, index) === PULLED_DOC_PREFIX) {
      // 下拉时 cite 会被还原成 "📄 [标题](URL)"，再推送时把前缀一起收掉，避免越滚越长
      index -= PULLED_DOC_PREFIX.length;
      text = PULLED_DOC_PREFIX + text;
    }

    const parsed = parseLarkDocUrl(rawUrl);
    if (!parsed || parsed.kind === "other") continue;
    matches.push({ text, index, trailing, parsed, isMarkdownLink });
  }

  return matches;
}

/**
 * 把正文里的飞书文档链接改写成 <cite>。任何一步不确定都保留原始链接。
 */
async function convertLarkLinksToCites(plugin, markdown, file) {
  if (typeof markdown !== "string" || !markdown) return markdown;
  if (!markdown.includes("http")) return markdown;

  const links = collectLarkLinks(markdown);
  if (links.length === 0) return markdown;

  const selfToken = readSelfToken(plugin, file);
  const replacements = new Map();
  for (const link of links) {
    if (replacements.has(link.text)) continue;
    let cite = null;
    try {
      cite = await resolveCiteTag(plugin, link.parsed, selfToken);
    } catch (error) {
      console.warn(`[ObLark Sync] 飞书链接改写失败，保留原始链接：${link.parsed.canonicalUrl}（${describeError(error)}）`);
    }
    if (cite) replacements.set(link.text, cite);
  }
  if (replacements.size === 0) return markdown;

  let result = "";
  let cursor = 0;
  let converted = 0;
  for (const link of links) {
    const cite = replacements.get(link.text);
    if (!cite || link.index < cursor) continue;
    result += markdown.slice(cursor, link.index) + cite;
    cursor = link.index + link.text.length;
    converted += 1;
  }
  result += markdown.slice(cursor);
  console.info(`[ObLark Sync] ${file?.path ?? "?"}：${converted} 个飞书文档链接已改写为文档提及`);
  return result;
}

function installLarkCiteLinks(PluginClass) {
  if (!PluginClass || PluginClass.prototype.__larkCiteLinksInstalled) return;
  const prototype = PluginClass.prototype;
  prototype.__larkCiteLinksInstalled = true;

  const originalReadNote = prototype.readNoteForLark;
  prototype.readNoteForLark = async function (file) {
    const content = await originalReadNote.call(this, file);
    try {
      return await convertLarkLinksToCites(this, content, file);
    } catch (error) {
      console.error(`[ObLark Sync] 飞书链接预处理失败，按原文同步：${file?.path}`, error);
      return content;
    }
  };

  console.info("[ObLark Sync] Installing Lark document link cite hooks");
}

function scheduleLarkCiteLinksInstall(pluginModule) {
  let attempts = 0;
  const install = () => {
    attempts += 1;
    try {
      const PluginClass = pluginModule?.default;
      if (!PluginClass) {
        if (attempts < 50) setTimeout(install, 20);
        else console.error("[ObLark Sync] 等待插件类超时，飞书链接引用扩展未安装");
        return false;
      }
      installLarkCiteLinks(PluginClass);
      return true;
    } catch (error) {
      console.error("[ObLark Sync] Failed to install Lark document link cite extension", error);
      return false;
    }
  };
  install();
}

module.exports = {
  installLarkCiteLinks,
  scheduleLarkCiteLinksInstall,
  convertLarkLinksToCites,
  collectLarkLinks,
  parseLarkDocUrl,
  resolveWikiObject,
  buildCiteTag,
  escapeXmlAttribute,
  WIKI_CACHE_KEY,
  CITE_READY_OBJECT_TYPES,
};
