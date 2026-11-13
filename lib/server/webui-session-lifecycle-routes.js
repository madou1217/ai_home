'use strict';

// 原生会话生命周期路由统一反代至 Go Core（零 Node session-lifecycle 回落）：
//   GET  /v0/webui/sessions/lifecycle-capabilities → GET  /v1/management/webui/sessions/lifecycle-capabilities
//   POST /v0/webui/sessions/archive                → POST /v1/management/webui/sessions/archive
//   GET  /v0/webui/sessions/archived               → GET  /v1/management/webui/sessions/archived
//   POST /v0/webui/sessions/unarchive              → POST /v1/management/webui/sessions/unarchive

const { proxyWebuiGo } = require('./webui-go-proxy');

const MAX_LIFECYCLE_BODY_BYTES = 64 * 1024;
const LIFECYCLE_PASS_STATUSES = Object.freeze([400, 404, 409, 422, 502, 503, 504]);

async function readLifecycleBody(ctx) {
  let rawBuffer = null;
  try {
    rawBuffer = await ctx.readRequestBody(ctx.req, { maxBytes: MAX_LIFECYCLE_BODY_BYTES });
  } catch (_error) {
    ctx.writeJson(ctx.res, 400, { ok: false, error: 'invalid_json', message: '读取请求体失败' });
    return { ok: false, body: null };
  }
  const rawText = rawBuffer ? rawBuffer.toString('utf8').trim() : '';
  if (!rawText) {
    return { ok: true, body: {} };
  }
  try {
    return { ok: true, body: JSON.parse(rawText) };
  } catch (_error) {
    ctx.writeJson(ctx.res, 400, { ok: false, error: 'invalid_json', message: '请求 JSON 无效' });
    return { ok: false, body: null };
  }
}

async function handleGetSessionLifecycleCapabilitiesRequest(ctx) {
  return proxyWebuiGo(ctx, {
    method: 'GET',
    path: '/v1/management/webui/sessions/lifecycle-capabilities',
    passStatuses: LIFECYCLE_PASS_STATUSES,
    message: 'Go Core 未就绪，会话生命周期能力不可读'
  });
}

async function handleArchiveSessionRequest(ctx) {
  const parsed = await readLifecycleBody(ctx);
  if (!parsed.ok) return true;
  return proxyWebuiGo(ctx, {
    method: 'POST',
    path: '/v1/management/webui/sessions/archive',
    body: parsed.body,
    passStatuses: LIFECYCLE_PASS_STATUSES,
    message: 'Go Core 未就绪，会话归档失败'
  });
}

async function handleGetArchivedSessionsRequest(ctx) {
  return proxyWebuiGo(ctx, {
    method: 'GET',
    path: '/v1/management/webui/sessions/archived',
    passStatuses: LIFECYCLE_PASS_STATUSES,
    message: 'Go Core 未就绪，已归档会话列表不可读'
  });
}

async function handleUnarchiveSessionRequest(ctx) {
  const parsed = await readLifecycleBody(ctx);
  if (!parsed.ok) return true;
  return proxyWebuiGo(ctx, {
    method: 'POST',
    path: '/v1/management/webui/sessions/unarchive',
    body: parsed.body,
    passStatuses: LIFECYCLE_PASS_STATUSES,
    message: 'Go Core 未就绪，恢复归档会话失败'
  });
}

module.exports = {
  handleArchiveSessionRequest,
  handleGetArchivedSessionsRequest,
  handleGetSessionLifecycleCapabilitiesRequest,
  handleUnarchiveSessionRequest
};
