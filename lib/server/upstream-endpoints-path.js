'use strict';
// 上游 URL/路径解析域。
//
// 历史：本文件由 scripts/upstream-endpoints-split.cjs（一次性拆分工具，已跑完）从
// upstream-endpoints.js 原样搬出。母文件已不再包含这些函数，因此**本文件现在是权威源**
// （旧头部那句「do not edit manually」已失效）。
//
// provider 差异一律用**数据表**表达（基址来源规则 / /v1 前缀剥离规则），派发处不判 provider。

const { resolveProviderApiBaseUrl } = require('../account/provider-api-base-url');
const { isCodebuddyFamilyProvider } = require('../account/codebuddy-billing');
const {
  resolveCodebuddyFamilyInferencePath
} = require('../account/codebuddy-family-inference');

// 上游基址的来源规则（数据）：从账号字段取，取不到再退回 options 上的对应键。
//   accountField                  —— 账号记录上的字段名
//   requireApiKeyMode: true       —— 只有 API Key 模式的账号才用账号字段（否则一律用 options）
const UPSTREAM_BASE_URL_RULES = Object.freeze({
  gemini: Object.freeze({ optionKey: 'geminiBaseUrl' }),
  agy: Object.freeze({ optionKey: 'agyBaseUrl', accountField: 'baseUrl' }),
  claude: Object.freeze({ optionKey: 'claudeBaseUrl', accountField: 'baseUrl' }),
  codex: Object.freeze({ optionKey: 'codexBaseUrl', accountField: 'openaiBaseUrl', requireApiKeyMode: true })
});

function readRuleAccountField(rule, account) {
  if (!rule.accountField || !account) return '';
  if (rule.requireApiKeyMode && !(account.apiKeyMode || account.authType === 'api-key')) return '';
  return String(account[rule.accountField] || '').trim();
}

function resolveProviderUpstream(options, provider, account) {
  const rule = UPSTREAM_BASE_URL_RULES[provider];
  // grok / kimi / kiro 在聊天与探测两条路径上共用同一条规则，因此住在
  // provider-api-base-url.js 里；两边都不管的 provider 解析成 ''，不会静默继承 codex 的端点。
  if (!rule) return resolveProviderApiBaseUrl(provider, account);
  const fromAccount = readRuleAccountField(rule, account);
  const fromOptions = String(options && options[rule.optionKey] || '').trim();
  return (fromAccount || fromOptions).replace(/\/+$/, '');
}


function baseUrlEndsWithPath(baseUrl, pathSuffix) {
  const normalizedBase = String(baseUrl || '').trim().toLowerCase().replace(/\/+$/, '');
  const normalizedSuffix = String(pathSuffix || '').trim().toLowerCase().replace(/^\/+/, '');
  if (!normalizedBase || !normalizedSuffix) return false;
  return normalizedBase.endsWith(`/${normalizedSuffix}`);
}


// 路径改写规则（数据）：
//   STRIP_V1_UNLESS_BASE_HAS_V1 —— 基址本身已带 /v1 时，把请求的 /v1 前缀去掉（claude/zcode 的
//     Anthropic 兼容端点 …/api/anthropic 需要保留 /v1，规则同 claude）。
//   STRIP_V1_PROVIDERS         —— 原生端点不含 /v1，一律把请求的 /v1 前缀去掉。
const STRIP_V1_UNLESS_BASE_HAS_V1 = Object.freeze(new Set(['claude', 'zcode']));
// 推理路径**丢掉客户端 query**的 provider：官方客户端对 zcode 的 plan 端点不带 query
// （`?beta=true` 尤其不带 —— 现场证据：Start Plan 请求带 beta=true 会被判 unusual
// activity），而我们的路径解析默认原样保留客户端 query。zcode 的 app_version 走的是
// 计费/探测那条 URL（appendZcodeAppVersion），不经过这里，因此丢弃是安全的。
const DROP_QUERY_PROVIDERS = Object.freeze(new Set(['zcode']));
const STRIP_V1_PROVIDERS = Object.freeze(new Set([
  'gemini', 'agy', 'claude', 'codex', 'grok', 'kimi', 'kiro', 'cline'
]));

function resolveProviderPath(provider, reqUrl, upstreamBase) {
  let rawPath = String(reqUrl || '').trim() || '/';
  // 丢弃客户端 query（见 DROP_QUERY_PROVIDERS 的说明）：在 v1 前缀处理之前做，
  // 保证后面的路径改写看到的都是无 query 的路径。
  if (DROP_QUERY_PROVIDERS.has(provider)) {
    const queryAt = rawPath.indexOf('?');
    if (queryAt >= 0) rawPath = rawPath.slice(0, queryAt) || '/';
  }
  // CodeBuddy / WorkBuddy 家族只认 `/v2/chat/completions`：客户端说的 OpenAI `/v1/...`
  // 必须抬成 `/v2/...`（实测上游 `/v1/chat/completions` 是 404 Route Not Found）。
  // 只改写这一条路径，不把任意 `/v1/*` 一律抬成 `/v2/*`——那会把不存在的路径伪装成
  // 存在的路径，报错反而更难查。
  if (isCodebuddyFamilyProvider(provider)) {
    return resolveCodebuddyFamilyInferencePath(provider, rawPath);
  }
  const isV1Root = rawPath === '/v1';
  const isV1Prefixed = isV1Root || rawPath.startsWith('/v1/');
  if (!isV1Prefixed) return rawPath;

  if (STRIP_V1_UNLESS_BASE_HAS_V1.has(provider)) {
    if (!baseUrlEndsWithPath(upstreamBase, 'v1')) return rawPath;
    return isV1Root ? '/' : rawPath.slice(3);
  }
  if (STRIP_V1_PROVIDERS.has(provider)) {
    return isV1Root ? '/' : rawPath.slice(3);
  }
  return rawPath;
}


function isAnthropicCompatibleBaseUrl(baseUrl) {
  const text = String(baseUrl || '').trim().toLowerCase().replace(/\/+$/, '');
  return text.includes('/apps/anthropic');
}


function stripUrlQueryAndHash(value) {
  return String(value || '').trim().split(/[?#]/, 1)[0] || '';
}


function isClaudeMessagesPath(pathname) {
  const value = stripUrlQueryAndHash(pathname);
  return value === '/messages' || value === '/v1/messages';
}


function isOpenAIChatCompletionsPath(pathname) {
  const value = stripUrlQueryAndHash(pathname);
  return value === '/chat/completions' || value === '/v1/chat/completions';
}


function isGeminiGenerateContentPath(pathname) {
  const value = stripUrlQueryAndHash(pathname);
  return /^\/v1(?:beta)?\/models\/[^/]+:(?:generateContent|streamGenerateContent)$/.test(value);
}


function isGeminiStreamGenerateContentPath(pathname) {
  const value = stripUrlQueryAndHash(pathname);
  return /^\/v1(?:beta)?\/models\/[^/]+:streamGenerateContent$/.test(value);
}


module.exports = { resolveProviderUpstream, baseUrlEndsWithPath, resolveProviderPath, isAnthropicCompatibleBaseUrl, stripUrlQueryAndHash, isClaudeMessagesPath, isOpenAIChatCompletionsPath, isGeminiGenerateContentPath, isGeminiStreamGenerateContentPath };
