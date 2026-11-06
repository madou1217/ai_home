'use strict';

const INTERNAL_ACCOUNT_LABEL_RE = /^(agy|codex|gemini|claude|opencode)-\d+$/i;
// kiro 的登录方式不是账号名：`Kiro (Google)` / `Kiro(AWS Builder ID)` 既不是昵称
// 也不能区分账号。展示层统一过滤，邮箱由用量快照的 account.email 补齐。
//
// 这里不再只写死 kiro 的几种登录方式：同一类「Provider 标签 + 括号限定」的合成名
// 每家都有（`OpenCode API (k3j9)` 就是密钥指纹），所以按**结构**判定——
// 前缀是 Provider 自己的名字、后面跟一个括号补充，就是零身份价值的名字。
const PROVIDER_LABEL_SUFFIX_RE = /^([A-Za-z][A-Za-z0-9 ._-]{1,32}?)\s*(?:API|CLI)?\s*[（(][^)）]{1,40}[)）]$/;

const DEFAULT_API_KEY_DOMAINS = Object.freeze({
  codex: 'api.openai.com',
  claude: 'api.anthropic.com',
  agy: 'daily-cloudcode-pa.googleapis.com',
  gemini: 'generativelanguage.googleapis.com',
  opencode: 'opencode.ai'
});

function isInternalAccountDisplayName(value) {
  return INTERNAL_ACCOUNT_LABEL_RE.test(String(value || '').trim());
}

// isMeaninglessNickname 判断一个展示名是否「没有任何身份价值」。
//
// 三类：Provider 自己的名字（`Kiro`）、Provider 名字 + 括号补充（`Kiro(Google)`、
// `OpenCode API (k3j9)`）、以及登录方式/密钥标签（`API Key`、`Access Token`）。
// 只有能对上 provider 时才按结构判定；拿不到 provider 时退回旧的 kiro 名单，
// 避免把用户自己起的 `Deo (工作号)` 误杀。
function isMeaninglessNickname(value, provider) {
  const text = String(value || '').trim();
  if (!text) return true;
  const providerID = String(provider || '').trim().toLowerCase();
  if (!providerID) {
    return /^Kiro\s*\((?:Google|GitHub|AWS Builder ID|IAM Identity Center|Desktop)\)$/i.test(text);
  }
  const normalizedProvider = providerID.replace(/[\s_-]+/g, '');
  const normalizedText = text.toLowerCase().replace(/[\s_-]+/g, '');
  if (normalizedText === normalizedProvider) return true;
  const match = PROVIDER_LABEL_SUFFIX_RE.exec(text);
  if (!match) return false;
  return match[1].toLowerCase().replace(/[\s_-]+/g, '') === normalizedProvider;
}

function cleanOauthDisplayName(value, provider) {
  const text = String(value || '').trim();
  if (!text || text === 'Unknown') return '';
  if (isInternalAccountDisplayName(text)) return '';
  if (isMeaninglessNickname(text, provider)) return '';
  if (/^api key/i.test(text)) return '';
  if (/^access token/i.test(text)) return '';
  return text;
}

function pickOauthDisplayName(...values) {
  for (const value of values) {
    const cleaned = cleanOauthDisplayName(value);
    if (cleaned) return cleaned;
  }
  return '';
}

// pickOauthDisplayNameFor 是按 Provider 过滤的版本：展示名/昵称走这里，
// 邮箱槽位仍用 pickOauthDisplayName（邮箱不可能等于 Provider 名字）。
//
// 「无意义昵称」不是直接丢弃而是**降级到最后**：`OpenCode API (k3j9)` 这类账号
// 可能真的没有邮箱/手机号，全丢掉会让标题变成空白。有身份就用身份，没身份才用它兜底。
function pickOauthDisplayNameFor(provider, ...values) {
  let fallback = '';
  for (const value of values) {
    const text = String(value == null ? '' : value).trim();
    if (!text || text === 'Unknown') continue;
    if (isInternalAccountDisplayName(text)) continue;
    if (/^api key/i.test(text) || /^access token/i.test(text)) continue;
    if (isMeaninglessNickname(text, provider)) {
      if (!fallback) fallback = text;
      continue;
    }
    return text;
  }
  return fallback;
}

// isMeaningfulFallback 只判断「值本身不是垃圾」：Unknown / 内部编号 / 空串不要，
// Provider 标签类昵称**要**（它是最后的兜底）。
function isMeaningfulFallback(value, provider) {
  const text = String(value || '').trim();
  if (!text || text === 'Unknown') return false;
  if (isInternalAccountDisplayName(text)) return false;
  if (/^api key/i.test(text) || /^access token/i.test(text)) return false;
  return true;
}

function getBaseDomain(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw.includes('://') ? raw : `https://${raw}`);
    return parsed.host.replace(/^www\./i, '');
  } catch (_error) {
    return raw
      .replace(/^[a-z]+:\/\//i, '')
      .split(/[/?#]/, 1)[0]
      .replace(/^www\./i, '');
  }
}

function getApiKeyDisplayName(provider, config = {}) {
  const domain = getBaseDomain(config.baseUrl || config.openaiBaseUrl || config.anthropicBaseUrl);
  if (domain) return domain;
  return DEFAULT_API_KEY_DOMAINS[String(provider || '').trim().toLowerCase()] || 'API Key';
}

// 账号标题轮播的输入：**单键值数组**，数组顺序就是轮播顺序。
//
// 为什么不继续用 displayName / email / phone 三个独立字段：每加一种身份（uin、员工号、
// 企业名…）都要改服务端结构、TS 类型和轮播组件。改成 `{ type, value }[]` 后，新增身份
// 只需要在服务端多 push 一项，消费方按 value 渲染即可。
//
// 顺序按用户口径：邮箱 → 手机号 → 昵称。手机号是完整号码；上游合成邮箱
// `<phone>@phone.local` 只保留号码，不把合成邮箱当成一项。
function isEmailDisplayValue(value) {
  return /^[^@\s]+@[^@\s]+$/.test(String(value == null ? '' : value).trim());
}

function buildAccountDisplayNames({ provider, displayName, nickname, phone, email, apiKeyMode } = {}) {
  const entries = [];
  const seen = new Set();
  const push = (type, value) => {
    const text = String(value == null ? '' : value).trim();
    if (!text || seen.has(text)) return;
    seen.add(text);
    entries.push({ type, value: text });
  };
  const emailText = String(email == null ? '' : email).trim();
  const syntheticPhone = /^(\d{6,})@phone\.local$/i.exec(emailText);
  // API Key 账号没有昵称：displayName 是端点域名/标签，用 name 表达更准确。
  // OAuth 账号的 displayName 本身可能就是邮箱（kiro / codebuddy 的常见形态），
  // 此时按 email 类型下发，消费方不会把一个邮箱误认成昵称。
  // 展示名/昵称都要过同一层清洗：OAuth 账号不能把 `Kiro (Google)`、内部编号等
  // 当作身份项下发；邮箱项由 email 槽位单独给。
  const rawDisplay = String(displayName == null ? '' : displayName).trim();
  const rawNick = String(nickname == null ? '' : nickname).trim();
  const displayText = apiKeyMode ? rawDisplay : cleanOauthDisplayName(displayName, provider);
  const fallbackNickname = apiKeyMode
    ? ''
    : (rawDisplay || rawNick);
  if (isEmailDisplayValue(emailText) && !syntheticPhone) push('email', emailText);
  push('phone', phone || (syntheticPhone ? syntheticPhone[1] : ''));
  if (apiKeyMode) {
    push('name', displayText);
    return entries;
  }
  // displayName 与 nickname 分开给：上游把邮箱写进 displayName 时，昵称仍要单独出现。
  // 两者相同则由 push 去重。
  if (isEmailDisplayValue(displayText)) push('email', displayText);
  else push('nickName', displayText);
  const nickText = apiKeyMode ? '' : cleanOauthDisplayName(nickname, provider);
  if (nickText) push('nickName', nickText);
  // 身份项全被过滤（只剩 Provider 标签类昵称）时，用它兜底——总比空标题好。
  // 有邮箱/手机号时不会走到这里。
  if (entries.length === 0 && isMeaningfulFallback(fallbackNickname, provider)) {
    push(isEmailDisplayValue(fallbackNickname) ? 'email' : 'nickName', fallbackNickname);
  }
  return entries;
}

module.exports = {
  buildAccountDisplayNames,
  cleanOauthDisplayName,
  getApiKeyDisplayName,
  getBaseDomain,
  isInternalAccountDisplayName,
  isMeaninglessNickname,
  pickOauthDisplayName,
  pickOauthDisplayNameFor
};
