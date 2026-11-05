'use strict';

const INTERNAL_ACCOUNT_LABEL_RE = /^(agy|codex|gemini|claude|opencode)-\d+$/i;
// kiro 的登录方式不是账号名：`Kiro (Google)` / `Kiro (AWS Builder ID)` 既不是昵称
// 也不能区分账号。展示层统一过滤，邮箱由用量快照的 account.email 补齐。
const GENERIC_KIRO_LABEL_RE = /^Kiro \((?:Google|GitHub|AWS Builder ID|IAM Identity Center|Desktop)\)$/i;

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

function cleanOauthDisplayName(value) {
  const text = String(value || '').trim();
  if (!text || text === 'Unknown') return '';
  if (isInternalAccountDisplayName(text)) return '';
  if (GENERIC_KIRO_LABEL_RE.test(text)) return '';
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

function buildAccountDisplayNames({ displayName, nickname, phone, email, apiKeyMode } = {}) {
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
  const displayText = apiKeyMode
    ? String(displayName == null ? '' : displayName).trim()
    : cleanOauthDisplayName(displayName);
  const nickText = apiKeyMode ? '' : cleanOauthDisplayName(nickname);
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
  if (nickText) push('nickName', nickText);
  return entries;
}

module.exports = {
  buildAccountDisplayNames,
  cleanOauthDisplayName,
  getApiKeyDisplayName,
  getBaseDomain,
  isInternalAccountDisplayName,
  pickOauthDisplayName
};
