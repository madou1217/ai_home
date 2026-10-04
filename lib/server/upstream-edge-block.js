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

module.exports = { isEdgeBlockedResponse, buildEdgeBlockedPolicy, looksLikeEdgeBlockHeaders };
