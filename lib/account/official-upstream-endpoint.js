'use strict';

// 「第三方上游」判定 —— 只回答一个问题：这个账号是不是在跟厂商官方端点之外的
// 上游（new-api / one-api / 自建反代 / 自建网关）说话？
//
// 账号级上游错误映射（WebUI「编辑调度规则」）是给这类上游用的：它们会把错误信封
// 改写成部署自己的样子（error.code / error.type / 自定义业务码），需要一套规则把
// 部署自定义的错误码对齐回系统语义。厂商官方端点返回的是标准错误码，内置启发式
// 已经覆盖，没有可对齐的东西 —— 所以 OAuth 登录态账号与官方地址的 API Key 账号
// 都不该有这套编辑入口，也没有可编辑的内容。
//
// 判定口径（唯一事实来源：WebUI 账号记录的 customUpstream 字段与 WebUI 接口的写入
// 守卫都消费这里，任何一侧都不得再写一份主机名表）：
//   1. OAuth 登录态账号（非 API 密钥模式）→ 不是第三方上游；
//   2. 没有配置 base URL → 走厂商官方默认端点 → 不是第三方上游；
//   3. 配置了 base URL → 主机名命中该 Provider 的官方主机表才算官方
//      （子路径、端口、大小写、`www.` 前缀都不影响判定）；
//   4. 回环地址（127.0.0.1 / localhost）算第三方上游 —— 自建 new-api / one-api
//      常常就跑在本机，而这恰恰是最需要规则的一类上游；
//   5. 官方主机表里没有的 Provider（含未知 Provider）→ 保守判为官方：宁可少给
//      入口，也不要让官方账号出现一套注定不命中的规则。新增 Provider 时
//      test/official-upstream-endpoint.test.js 会要求显式登记官方主机。

// 每个 Provider 的官方端点主机（不含协议/路径）。来源见各行注释；这些常量本身
// 属于运行时端点定义，漂移由 test/official-upstream-endpoint.test.js 的对照断言守住。
const OFFICIAL_UPSTREAM_HOSTS = Object.freeze({
  // lib/server/account-display-identity.js 的 DEFAULT_API_KEY_DOMAINS。
  codex: Object.freeze(['api.openai.com']),
  claude: Object.freeze(['api.anthropic.com']),
  gemini: Object.freeze(['generativelanguage.googleapis.com']),
  agy: Object.freeze(['daily-cloudcode-pa.googleapis.com', 'cloudcode-pa.googleapis.com']),
  opencode: Object.freeze(['opencode.ai']),
  // lib/account/provider-api-base-url.js 的默认端点常量。
  grok: Object.freeze(['api.x.ai']),
  kiro: Object.freeze(['q.us-east-1.amazonaws.com']),
  cline: Object.freeze(['api.cline.bot']),
  zcode: Object.freeze(['open.bigmodel.cn', 'api.z.ai', 'zcode.z.ai']),
  // lib/account/kimi-endpoints.js：编码端点 + 公开 API 端点。
  kimi: Object.freeze(['api.kimi.com', 'api.moonshot.cn', 'api.moonshot.ai']),
  // lib/account/codebuddy-family-inference.js 的 CODEBUDDY_FAMILY_INFERENCE_BASE_URLS。
  codebuddy: Object.freeze(['codebuddy.ai']),
  workbuddy: Object.freeze(['workbuddy.ai']),
  codebuddycn: Object.freeze(['copilot.tencent.com']),
  workbuddycn: Object.freeze(['copilot.tencent.com'])
});

function normalizeProvider(provider) {
  return String(provider || '').trim().toLowerCase();
}

// 解析 base URL 的主机名。允许省略协议（用户常填 `api.openai.com/v1`），解析不出来
// 返回空串 —— 调用方据此区分「空配置」与「配了但不可解析」。
function readUpstreamHost(baseUrl) {
  const text = String(baseUrl || '').trim();
  if (!text) return '';
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
  try {
    return new URL(withScheme).hostname.toLowerCase();
  } catch (_error) {
    return '';
  }
}

function isLoopbackHost(host) {
  const normalized = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost'
    || normalized === '::1'
    || normalized === '0.0.0.0'
    || /^127\./.test(normalized);
}

/** 该 Provider 的官方主机清单（未知 Provider 为空数组）。 */
function listOfficialUpstreamHosts(provider) {
  return OFFICIAL_UPSTREAM_HOSTS[normalizeProvider(provider)] || [];
}

/** 主机是否命中官方清单：精确相等或其子域（`www.codebuddy.ai` 命中 `codebuddy.ai`）。 */
function isOfficialUpstreamHost(provider, host) {
  const normalized = String(host || '').trim().toLowerCase();
  if (!normalized) return false;
  return listOfficialUpstreamHosts(provider)
    .some((official) => normalized === official || normalized.endsWith(`.${official}`));
}

/**
 * 是否直连厂商官方端点：未配置 base URL（用官方默认）或主机命中官方清单。
 * 未登记官方主机表的 Provider 没有可判定的官方边界 → 保守判为官方；配置了却解析不出
 * 主机、或指向本机地址 → 都不是官方端点。
 */
function isOfficialUpstreamEndpoint(provider, baseUrl) {
  if (!listOfficialUpstreamHosts(provider).length) return true;
  const text = String(baseUrl || '').trim();
  if (!text) return true;
  const host = readUpstreamHost(text);
  if (!host) return false;
  if (isLoopbackHost(host)) return false;
  return isOfficialUpstreamHost(provider, host);
}

/**
 * 账号是否属于「第三方/自建上游的 API Key 账号」—— 唯一允许配置调度规则的形态。
 * OAuth 登录态账号与官方地址账号一律为 false。
 */
function isCustomUpstreamAccount(options = {}) {
  if (!options.apiKeyMode) return false;
  return !isOfficialUpstreamEndpoint(options.provider, options.baseUrl);
}

module.exports = {
  OFFICIAL_UPSTREAM_HOSTS,
  isCustomUpstreamAccount,
  isOfficialUpstreamEndpoint,
  isOfficialUpstreamHost,
  listOfficialUpstreamHosts,
  readUpstreamHost
};
