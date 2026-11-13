'use strict';

// WebUI 项目目录与工作区模型目录路由统一反代至 Go Core（零 Node 回落）：
//   GET  /v0/webui/models            → GET  /v1/management/webui/workspace/models
//   GET  /v0/webui/projects          → GET  /v1/management/webui/projects
//   GET  /v0/webui/projects/sessions → GET  /v1/management/webui/projects/sessions
//   POST /v0/webui/projects/pick     → POST /v1/management/webui/projects/pick
//   POST /v0/webui/projects/browse   → POST /v1/management/webui/projects/browse
//   POST /v0/webui/projects/open     → POST /v1/management/webui/projects/open
//   POST /v0/webui/projects/remove   → POST /v1/management/webui/projects/remove

const { proxyWebuiGo } = require('./webui-go-proxy');

const MAX_PROJECT_BODY_BYTES = 1024 * 1024;
const PROJECT_PASS_STATUSES = Object.freeze([400, 403, 404, 409, 500, 501]);

function readQueryString(ctx) {
  if (ctx && ctx.url && ctx.url.searchParams) {
    return ctx.url.searchParams.toString();
  }
  const rawUrl = String((ctx && ctx.req && ctx.req.url) || '');
  const qIndex = rawUrl.indexOf('?');
  return qIndex >= 0 ? rawUrl.slice(qIndex + 1) : '';
}

async function readOptionalJsonBody(ctx) {
  if (!ctx || typeof ctx.readRequestBody !== 'function') {
    return { ok: true, body: {} };
  }
  let rawBuffer = null;
  try {
    rawBuffer = await ctx.readRequestBody(ctx.req, { maxBytes: MAX_PROJECT_BODY_BYTES });
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
    ctx.writeJson(ctx.res, 400, { ok: false, error: 'invalid_json', message: '请求体 JSON 无效' });
    return { ok: false, body: null };
  }
}

function proxyProjectGet(ctx, path, message) {
  return proxyWebuiGo(ctx, {
    method: 'GET',
    path,
    query: readQueryString(ctx),
    passStatuses: PROJECT_PASS_STATUSES,
    message
  });
}

async function proxyProjectPost(ctx, path, message) {
  const parsed = await readOptionalJsonBody(ctx);
  if (!parsed.ok) return true;
  return proxyWebuiGo(ctx, {
    method: 'POST',
    path,
    body: parsed.body,
    passStatuses: PROJECT_PASS_STATUSES,
    message
  });
}

const handleGetModelsRequest = (ctx) => proxyProjectGet(ctx, '/v1/management/webui/workspace/models', 'Go Core 未就绪，模型目录不可读');
const handleGetProjectsRequest = (ctx) => proxyProjectGet(ctx, '/v1/management/webui/projects', 'Go Core 未就绪，项目列表不可读');
const handleGetProjectSessionsRequest = (ctx) => proxyProjectGet(ctx, '/v1/management/webui/projects/sessions', 'Go Core 未就绪，项目会话列表不可读');
const handlePickProjectRequest = (ctx) => proxyProjectPost(ctx, '/v1/management/webui/projects/pick', 'Go Core 未就绪，无法呼出目录选择器');
const handleBrowseProjectsRequest = (ctx) => proxyProjectPost(ctx, '/v1/management/webui/projects/browse', 'Go Core 未就绪，目录浏览不可用');
const handleOpenProjectRequest = (ctx) => proxyProjectPost(ctx, '/v1/management/webui/projects/open', 'Go Core 未就绪，无法打开项目');
const handleRemoveProjectRequest = (ctx) => proxyProjectPost(ctx, '/v1/management/webui/projects/remove', 'Go Core 未就绪，无法移除项目');

module.exports = {
  handleGetModelsRequest,
  handleGetProjectsRequest,
  handleGetProjectSessionsRequest,
  handlePickProjectRequest,
  handleOpenProjectRequest,
  handleRemoveProjectRequest,
  handleBrowseProjectsRequest
};
