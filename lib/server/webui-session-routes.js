'use strict';

// 会话读取统一薄代理：列表、消息分页、预览、增量事件与会话最近模型全部直走 Go Core，
// Go 不可用时显式返回 503，不再保留本地 Node 兜底读取逻辑。

const { proxyWebuiGo } = require('./webui-go-proxy');

const SESSION_READ_PASS_STATUSES = Object.freeze([400, 404, 409, 501]);

function encodeRouteSegment(raw) {
  const value = String(raw || '');
  try {
    return encodeURIComponent(decodeURIComponent(value));
  } catch (_error) {
    return encodeURIComponent(value);
  }
}

function resolveSearchQuery(ctx) {
  if (ctx && ctx.url && ctx.url.searchParams) {
    return ctx.url.searchParams.toString();
  }
  const rawUrl = ctx && ctx.req && ctx.req.url ? String(ctx.req.url) : '';
  const qIndex = rawUrl.indexOf('?');
  return qIndex >= 0 ? rawUrl.slice(qIndex + 1) : '';
}

async function handleGetAccountSessionsRequest(ctx) {
  const matches = String((ctx && ctx.pathname) || '').match(/^\/v0\/webui\/sessions\/([^/]+)\/([^/]+)$/);
  if (!matches) {
    ctx.writeJson(ctx.res, 404, { ok: false, error: 'not_found' });
    return true;
  }
  return proxyWebuiGo(ctx, {
    method: 'GET',
    path: `/v1/management/webui/sessions/${encodeRouteSegment(matches[1])}/${encodeRouteSegment(matches[2])}`,
    query: resolveSearchQuery(ctx),
    passStatuses: SESSION_READ_PASS_STATUSES,
    message: 'Go Core 会话列表服务不可用'
  });
}

async function handleGetSessionMessagesRequest(ctx) {
  const matches = String((ctx && ctx.pathname) || '').match(/^\/v0\/webui\/sessions\/([^/]+)\/([^/]+)\/messages$/);
  if (!matches) {
    ctx.writeJson(ctx.res, 404, { ok: false, error: 'not_found' });
    return true;
  }
  return proxyWebuiGo(ctx, {
    method: 'GET',
    path: `/v1/management/webui/sessions/${encodeRouteSegment(matches[1])}/${encodeRouteSegment(matches[2])}/messages`,
    query: resolveSearchQuery(ctx),
    passStatuses: SESSION_READ_PASS_STATUSES,
    message: 'Go Core 会话消息服务不可用'
  });
}

async function handleSessionPreviewsRequest(ctx) {
  const raw = await ctx.readRequestBody(ctx.req, { maxBytes: 256 * 1024 }).catch(() => null);
  const rawText = raw ? raw.toString('utf8').trim() : '';
  let payload = null;
  if (rawText) {
    try {
      payload = JSON.parse(rawText);
    } catch (_error) {
      ctx.writeJson(ctx.res, 400, { ok: false, error: 'invalid_json_body', message: '请求体不是合法 JSON' });
      return true;
    }
  }
  const items = Array.isArray(payload && payload.sessions) ? payload.sessions.slice(0, 40) : [];
  return proxyWebuiGo(ctx, {
    method: 'POST',
    path: '/v1/management/webui/sessions/previews',
    body: { sessions: items },
    passStatuses: SESSION_READ_PASS_STATUSES,
    message: 'Go Core 会话预览服务不可用',
    transform: (data) => {
      const list = Array.isArray(data && data.previews) ? data.previews : [];
      return {
        ok: true,
        previews: list.map((item) => {
          const { error: _error, ...rest } = item || {};
          return rest;
        })
      };
    }
  });
}

async function handleGetSessionEventsRequest(ctx) {
  const matches = String((ctx && ctx.pathname) || '').match(/^\/v0\/webui\/sessions\/([^/]+)\/([^/]+)\/events$/);
  if (!matches) {
    ctx.writeJson(ctx.res, 404, { ok: false, error: 'not_found' });
    return true;
  }
  return proxyWebuiGo(ctx, {
    method: 'GET',
    path: `/v1/management/webui/sessions/${encodeRouteSegment(matches[1])}/${encodeRouteSegment(matches[2])}/events`,
    query: resolveSearchQuery(ctx),
    passStatuses: SESSION_READ_PASS_STATUSES,
    message: 'Go Core 会话事件服务不可用'
  });
}

async function handleGetSessionModelRequest(ctx) {
  const matches = String((ctx && ctx.pathname) || '').match(/^\/v0\/webui\/sessions\/([^/]+)\/([^/]+)\/model$/);
  if (!matches) {
    ctx.writeJson(ctx.res, 404, { ok: false, error: 'not_found' });
    return true;
  }
  return proxyWebuiGo(ctx, {
    method: 'GET',
    path: `/v1/management/webui/sessions/${encodeRouteSegment(matches[1])}/${encodeRouteSegment(matches[2])}/model`,
    passStatuses: SESSION_READ_PASS_STATUSES,
    message: 'Go Core 会话模型服务不可用'
  });
}

module.exports = {
  handleGetAccountSessionsRequest,
  handleGetSessionMessagesRequest,
  handleSessionPreviewsRequest,
  handleGetSessionEventsRequest,
  handleGetSessionModelRequest,
  tryHandleGetSessionEventsViaGo: handleGetSessionEventsRequest
};
