'use strict';

// 上游边缘（Cloudflare 等 WAF/CDN）返回的 401/403 拦截页不是账号凭据失效。
//
// 曾经的事故：一个无正文的 GET /v1/messages 被拼到 chatgpt.com/backend-api/codex/messages，
// Cloudflare 回 403 HTML，通用透传把它判成 auth_invalid_reauth_required，给两个健康的
// OAuth 账号各挂上一年冷却。边缘拦截与账号无关（换号只会得到同一张拦截页），
// 所以既不记账号失败，也不换号重试。真正的凭据失效由上游 API 以 JSON 错误体回答。

function readHeader(headers, name) {
  if (!headers) return '';
  if (typeof headers.get === 'function') return String(headers.get(name) || '');
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name);
  const value = key ? headers[key] : '';
  return String(Array.isArray(value) ? value[0] : value || '');
}

// 只看响应头的快速判定：用于在强制刷新 token 之前截住拦截页（刷新会轮换 OAuth 凭据）。
function looksLikeEdgeBlockHeaders(headers) {
  return Boolean(readHeader(headers, 'cf-mitigated'))
    || readHeader(headers, 'content-type').toLowerCase().startsWith('text/html');
}

function isEdgeBlockedResponse(options = {}) {
  if (readHeader(options.headers, 'cf-mitigated')) return true;
  const contentType = readHeader(options.headers, 'content-type').toLowerCase();
  const body = String(options.body || '').trimStart().slice(0, 512).toLowerCase();
  const htmlBody = body.startsWith('<!doctype html') || body.startsWith('<html');
  return htmlBody || (contentType.startsWith('text/html') && !body.startsWith('{'));
}

// APISIX 类边缘网关的**请求格式拒绝**：`server: APISIX/*` + `{"message":"invalid_format"}`。
//
// 事故（2026-10-15）：家族端点（www.workbuddy.ai/v2/chat/completions，腾讯 EdgeOne + APISIX 栈）
// 对某次请求回了 401 + `{"message":"invalid_format"}`（content-type text/plain），被通用 401
// 分支判成 auth_invalid_reauth_required，给一个**完全健康**的账号挂了 31 536 000 000 ms 冷却；
// 事后同一 token 换请求形态直连 200、换号也是同一张拒绝 —— 它描述的是请求格式，不是凭据。
//
// 三个条件必须同时成立（避免把厂商真正的 401 吞掉）：
//   1) `server: APISIX/*` 头（网关签名，厂商 API 自己的错误不带这个）；
//   2) 正文是**只有 message 一个键**的 JSON 对象（家族自己的错误信封是 `{code,msg}`）；
//   3) message 不含凭据语义（auth/token/key/expired/…）—— 任何像凭据问题的回答仍按凭据处理。
const EDGE_GATEWAY_CREDENTIAL_MESSAGE_PATTERN =
  /auth|token|credential|login|sign.?in|unauthoriz|forbidden|permission|expired|apikey|api.?key/i;

function isEdgeGatewayFormatRejection(options = {}) {
  const server = readHeader(options.headers, 'server').toLowerCase();
  if (!server.includes('apisix')) return false;
  const body = String(options.body || '').trim();
  if (!body.startsWith('{')) return false;
  let parsed = null;
  try {
    parsed = JSON.parse(body);
  } catch (_error) {
    return false;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  const keys = Object.keys(parsed);
  if (keys.length !== 1 || keys[0] !== 'message') return false;
  if (typeof parsed.message !== 'string') return false;
  const message = parsed.message.trim();
  if (!message) return false;
  return !EDGE_GATEWAY_CREDENTIAL_MESSAGE_PATTERN.test(message);
}

function buildEdgeGatewayFormatRejectedPolicy(detail, statusCode) {
  return {
    kind: 'upstream_edge_format_rejected',
    // 与 WAF 拦截同一语义：请求形态被站点边缘拒绝，与账号凭据无关，
    // 因此不记账、不换号（同一请求换账号只会拿到同一张拒绝）。
    retryable: false,
    shouldMarkFailure: false,
    shouldRetryAnotherAccount: false,
    shouldPassthroughToClient: false,
    failureThreshold: 0,
    cooldownMs: 0,
    clientStatusCode: 502,
    failureReason: `upstream_edge_format_rejected_${statusCode}`,
    detail,
    scope: 'none',
    shouldUnbindSession: false
  };
}

function buildEdgeBlockedPolicy(detail, statusCode) {
  return {
    kind: 'upstream_edge_blocked',
    retryable: false,
    shouldMarkFailure: false,
    shouldRetryAnotherAccount: false,
    shouldPassthroughToClient: false,
    failureThreshold: 0,
    cooldownMs: 0,
    clientStatusCode: 502,
    failureReason: `upstream_edge_blocked_${statusCode}`,
    detail,
    scope: 'none',
    shouldUnbindSession: false
  };
}

module.exports = {
  isEdgeBlockedResponse,
  isEdgeGatewayFormatRejection,
  buildEdgeBlockedPolicy,
  buildEdgeGatewayFormatRejectedPolicy,
  looksLikeEdgeBlockHeaders
};
