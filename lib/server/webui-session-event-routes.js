'use strict';

// Provider Hook 会话事件接收统一反代至 Go Core（零 Node 事件总线/状态存储回落）：
//   POST /v0/webui/session-events/provider-hook → POST /v1/management/webui/session-events/provider-hook

const { proxyWebuiGo } = require('./webui-go-proxy');

const MAX_HOOK_BODY_BYTES = 256 * 1024;
const HOOK_PASS_STATUSES = Object.freeze([400, 404, 409, 422, 503]);

function readQueryString(ctx) {
  if (ctx && ctx.url && ctx.url.searchParams) {
    return ctx.url.searchParams.toString();
  }
  const rawUrl = String((ctx && ctx.req && ctx.req.url) || '');
  const qIndex = rawUrl.indexOf('?');
  return qIndex >= 0 ? rawUrl.slice(qIndex + 1) : '';
}

async function handleProviderHookSessionEventRequest(ctx) {
  let rawBuffer = null;
  try {
    rawBuffer = await ctx.readRequestBody(ctx.req, { maxBytes: MAX_HOOK_BODY_BYTES });
  } catch (_error) {
    ctx.writeJson(ctx.res, 400, { ok: false, error: 'invalid_payload' });
    return true;
  }

  let body = null;
  try {
    body = rawBuffer ? JSON.parse(rawBuffer.toString('utf8')) : null;
  } catch (_error) {
    body = null;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    ctx.writeJson(ctx.res, 400, { ok: false, error: 'invalid_payload' });
    return true;
  }

  return proxyWebuiGo(ctx, {
    method: 'POST',
    path: '/v1/management/webui/session-events/provider-hook',
    query: readQueryString(ctx),
    body,
    passStatuses: HOOK_PASS_STATUSES,
    message: 'Go Core 未就绪，Provider Hook 事件接收失败'
  });
}

module.exports = {
  handleProviderHookSessionEventRequest
};
