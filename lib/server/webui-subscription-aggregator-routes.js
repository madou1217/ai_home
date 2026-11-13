'use strict';

// 订阅聚合器 WebUI 管理面路由（/v0/webui/toolkit/subscription-aggregator*）：
// 全量 CRUD、规则编译/路由测试、节点探测/测速、异步同步作业与 SSE 进度流、本机中转边车
// 全部已迁移至 Go（webuitoolkitextapi + internal/runtime/subaggregator）。Node 侧只保留零回落代理。

const { readRequestBody, writeJson: sharedWriteJson } = require('./http-utils');
const { proxyWebuiGo, resolveGoHost } = require('./webui-go-proxy');

const ROUTE_PREFIX = '/v0/webui/toolkit/subscription-aggregator';
const GO_PREFIX = '/v1/management/webui/toolkit/subscription-aggregator';
const MAX_JSON_BODY_BYTES = 256 * 1024;
const MAX_SOURCE_BODY_BYTES = 3 * 1024 * 1024;
const PASS_STATUSES = [400, 403, 404, 409, 413, 422, 502];
const HOST_HEADER_PATTERN = /^[A-Za-z0-9.-]+(?::\d{1,5})?$|^\[[0-9A-Fa-f:.]+\](?::\d{1,5})?$/;

function firstHeader(value) {
  const text = Array.isArray(value) ? value[0] : value;
  return String(text || '').split(',')[0].trim();
}

function readRequestOrigin(req) {
  const headers = (req && req.headers) || {};
  const host = firstHeader(headers['x-forwarded-host']) || firstHeader(headers.host);
  if (!HOST_HEADER_PATTERN.test(host)) return '';
  const forwardedProto = firstHeader(headers['x-forwarded-proto']).toLowerCase();
  const proto = ['http', 'https'].includes(forwardedProto)
    ? forwardedProto
    : (req && req.socket && req.socket.encrypted ? 'https' : 'http');
  return `${proto}://${host}`;
}

function readRemoteAddress(req) {
  return String((req && req.socket && req.socket.remoteAddress) || '').trim();
}

function pathId(pathname, prefix, suffix = '') {
  if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) return '';
  const raw = pathname.slice(prefix.length, pathname.length - suffix.length);
  if (!raw || raw.includes('/')) return '';
  try {
    return decodeURIComponent(raw);
  } catch (_error) {
    return '';
  }
}

function isBodyTooLargeError(error) {
  const code = String((error && (error.code || error.message)) || '');
  return code === 'request_body_too_large' || code === 'Body too large';
}

async function readJson(ctx, req, maxBytes = MAX_JSON_BODY_BYTES) {
  const read = ctx.readRequestBody || readRequestBody;
  const buffer = await read(req, { maxBytes });
  const text = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer || '');
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch (_error) {
    const error = new Error('invalid_json_body');
    error.code = 'invalid_json_body';
    throw error;
  }
}

function buildRemoteQuery(req, extraParams = {}) {
  const params = new URLSearchParams();
  params.set('remoteAddr', readRemoteAddress(req) || 'unknown');
  for (const [k, v] of Object.entries(extraParams)) {
    if (v !== undefined && v !== null && String(v) !== '') {
      params.set(k, String(v));
    }
  }
  return params.toString();
}

async function proxySyncWatchStream(req, res, ctx, send) {
  const goHost = resolveGoHost(ctx);
  if (!goHost || typeof goHost.openWebuiStream !== 'function') {
    send(res, 503, {
      ok: false,
      error: 'go_core_unavailable',
      message: 'Go Core 未就绪，同步进度监听流不可用'
    });
    return true;
  }

  let closed = false;
  let reader = null;
  const abort = () => {
    if (closed) return;
    closed = true;
    if (reader) {
      try { reader.cancel(); } catch (_error) {}
    }
  };
  if (req && typeof req.on === 'function') req.on('close', abort);
  if (res && typeof res.on === 'function') {
    res.on('close', abort);
    res.on('error', abort);
  }

  let upstream = null;
  try {
    upstream = await goHost.openWebuiStream({
      method: 'GET',
      path: `${GO_PREFIX}/sources/sync/watch`,
      accept: 'text/event-stream'
    });
  } catch (_error) {
    upstream = null;
  }

  if (closed || (req && req.destroyed) || (res && (res.destroyed || res.writableEnded))) {
    if (upstream && upstream.body && typeof upstream.body.cancel === 'function') {
      try { await upstream.body.cancel(); } catch (_error) {}
    }
    return true;
  }

  if (!upstream) {
    send(res, 503, {
      ok: false,
      error: 'go_core_unavailable',
      message: 'Go Core 未就绪，同步进度监听流不可用'
    });
    return true;
  }

  if (!upstream.ok || !upstream.body) {
    const text = typeof upstream.text === 'function' ? await upstream.text().catch(() => '') : '';
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch (_error) { payload = null; }
    send(res, Number(upstream.status) || 502, payload || { ok: false, error: 'subscription_aggregator_failed' });
    return true;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  reader = upstream.body.getReader();
  try {
    while (!closed) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(Buffer.from(value))) {
        await new Promise((resolve) => {
          const finish = () => {
            res.off('drain', finish);
            res.off('close', finish);
            resolve();
          };
          res.once('drain', finish);
          res.once('close', finish);
        });
      }
    }
  } catch (_error) {
    // 客户端断开或 Go 流结束。
  }
  try { res.end(); } catch (_error) {}
  return true;
}

/**
 * 订阅聚合器的管理面（WebUI，受 Management Key 保护）。公开的订阅拉取走
 * subscription-aggregator-public-route.js 的 /sub/<token>。
 */
async function handleWebUiSubscriptionAggregatorRoutes(req, res, method, pathname, ctx = {}) {
  if (pathname !== ROUTE_PREFIX && !pathname.startsWith(`${ROUTE_PREFIX}/`)) return false;
  const send = ctx.writeJson || sharedWriteJson;
  const proxyCtx = { ...ctx, req, res, method, writeJson: send };

  const forward = (goMethod, goPath, options = {}) => proxyWebuiGo(proxyCtx, {
    method: goMethod,
    path: goPath,
    query: options.query,
    body: options.body,
    status: options.status,
    passStatuses: PASS_STATUSES,
    useFullBody: true,
    message: options.message || 'Go Core 未就绪，订阅聚合器服务不可用'
  });

  const forwardJsonPost = async (goPath, maxBytes = MAX_JSON_BODY_BYTES, options = {}) => {
    const body = await readJson(ctx, req, maxBytes);
    return forward('POST', goPath, { ...options, body });
  };

  try {
    if (method === 'GET' && pathname === ROUTE_PREFIX) {
      return forward('GET', GO_PREFIX);
    }
    if (method === 'GET' && pathname === `${ROUTE_PREFIX}/local-clients`) {
      return forward('GET', `${GO_PREFIX}/local-clients`, { query: buildRemoteQuery(req) });
    }
    if (method === 'GET' && pathname === `${ROUTE_PREFIX}/local-sources`) {
      return forward('GET', `${GO_PREFIX}/local-sources`, { query: buildRemoteQuery(req) });
    }
    if (method === 'POST' && pathname === `${ROUTE_PREFIX}/local-sources/import`) {
      return forwardJsonPost(`${GO_PREFIX}/local-sources/import`, MAX_JSON_BODY_BYTES, {
        query: buildRemoteQuery(req)
      });
    }
    if (method === 'GET' && pathname === `${ROUTE_PREFIX}/sources/sync/watch`) {
      return proxySyncWatchStream(req, res, ctx, send);
    }
    if (method === 'GET' && pathname === `${ROUTE_PREFIX}/relay`) {
      return forward('GET', `${GO_PREFIX}/relay`, { query: buildRemoteQuery(req) });
    }
    if (method === 'POST' && pathname === `${ROUTE_PREFIX}/profiles`) {
      return forwardJsonPost(`${GO_PREFIX}/profiles`);
    }
    if (method === 'POST' && pathname === `${ROUTE_PREFIX}/profiles/nodes`) {
      return forwardJsonPost(`${GO_PREFIX}/profiles/nodes`);
    }
    if (method === 'POST' && pathname === `${ROUTE_PREFIX}/profiles/test-route`) {
      return forwardJsonPost(`${GO_PREFIX}/profiles/test-route`);
    }
    if (method === 'POST' && pathname === `${ROUTE_PREFIX}/probe`) {
      return forwardJsonPost(`${GO_PREFIX}/probe`);
    }
    if (method === 'POST' && pathname === `${ROUTE_PREFIX}/nodes/parse`) {
      return forwardJsonPost(`${GO_PREFIX}/nodes/parse`, MAX_SOURCE_BODY_BYTES);
    }
    if (method === 'GET' && pathname === `${ROUTE_PREFIX}/nodes`) {
      return forward('GET', `${GO_PREFIX}/nodes`);
    }
    if (method === 'POST' && pathname === `${ROUTE_PREFIX}/nodes/chain`) {
      return forwardJsonPost(`${GO_PREFIX}/nodes/chain`);
    }
    if (method === 'POST' && pathname === `${ROUTE_PREFIX}/sources/preview`) {
      return forwardJsonPost(`${GO_PREFIX}/sources/preview`, MAX_SOURCE_BODY_BYTES);
    }
    if (method === 'POST' && pathname === `${ROUTE_PREFIX}/sources`) {
      return forwardJsonPost(`${GO_PREFIX}/sources`, MAX_SOURCE_BODY_BYTES);
    }
    if (method === 'POST' && pathname === `${ROUTE_PREFIX}/sources/sync`) {
      return forwardJsonPost(`${GO_PREFIX}/sources/sync`, MAX_JSON_BODY_BYTES, { status: 202 });
    }

    const profilePrefix = `${ROUTE_PREFIX}/profiles/`;
    const sourcePrefix = `${ROUTE_PREFIX}/sources/`;
    const profileTokenId = method === 'POST' ? pathId(pathname, profilePrefix, '/token') : '';
    if (profileTokenId) {
      return forward('POST', `${GO_PREFIX}/profiles/${encodeURIComponent(profileTokenId)}/token`, { body: {} });
    }

    const profilePreviewId = method === 'GET' ? pathId(pathname, profilePrefix, '/preview') : '';
    if (profilePreviewId) {
      const url = new URL(req.url || pathname, 'http://localhost');
      const params = new URLSearchParams(url.searchParams);
      params.set('remoteAddr', readRemoteAddress(req) || 'unknown');
      const origin = readRequestOrigin(req);
      if (origin && !params.get('origin')) params.set('origin', origin);
      return forward('GET', `${GO_PREFIX}/profiles/${encodeURIComponent(profilePreviewId)}/preview`, {
        query: params.toString()
      });
    }

    const profileLinksId = method === 'GET' ? pathId(pathname, profilePrefix, '/import-links') : '';
    if (profileLinksId) {
      const url = new URL(req.url || pathname, 'http://localhost');
      const origin = url.searchParams.get('origin') || readRequestOrigin(req);
      const params = new URLSearchParams();
      if (origin) params.set('origin', origin);
      return forward('GET', `${GO_PREFIX}/profiles/${encodeURIComponent(profileLinksId)}/import-links`, {
        query: params.toString()
      });
    }

    const profileDeleteId = method === 'DELETE' ? pathId(pathname, profilePrefix) : '';
    if (profileDeleteId) {
      return forward('DELETE', `${GO_PREFIX}/profiles/${encodeURIComponent(profileDeleteId)}`);
    }

    const sourceNodesId = method === 'GET' ? pathId(pathname, sourcePrefix, '/nodes') : '';
    if (sourceNodesId) {
      return forward('GET', `${GO_PREFIX}/sources/${encodeURIComponent(sourceNodesId)}/nodes`);
    }

    const sourceLatencyId = method === 'POST' ? pathId(pathname, sourcePrefix, '/latency') : '';
    if (sourceLatencyId) {
      return forwardJsonPost(`${GO_PREFIX}/sources/${encodeURIComponent(sourceLatencyId)}/latency`);
    }

    const sourceSyncId = method === 'POST' ? pathId(pathname, sourcePrefix, '/sync') : '';
    if (sourceSyncId) {
      return forward('POST', `${GO_PREFIX}/sources/${encodeURIComponent(sourceSyncId)}/sync`, {
        body: {},
        status: 202
      });
    }

    const sourceEnabledId = method === 'POST' ? pathId(pathname, sourcePrefix, '/enabled') : '';
    if (sourceEnabledId) {
      return forwardJsonPost(`${GO_PREFIX}/sources/${encodeURIComponent(sourceEnabledId)}/enabled`);
    }

    const sourceDeleteId = method === 'DELETE' ? pathId(pathname, sourcePrefix) : '';
    if (sourceDeleteId) {
      return forward('DELETE', `${GO_PREFIX}/sources/${encodeURIComponent(sourceDeleteId)}`);
    }
  } catch (error) {
    if (isBodyTooLargeError(error)) {
      send(res, 413, { ok: false, error: 'request_body_too_large' });
      return true;
    }
    const code = (error && error.code) || 'subscription_aggregator_failed';
    const message = error && error.message && error.message !== code ? error.message : undefined;
    send(res, code === 'invalid_json_body' ? 400 : 500, {
      ok: false,
      error: code,
      ...(message ? { message } : {})
    });
    return true;
  }

  return false;
}

module.exports = {
  ROUTE_PREFIX,
  handleWebUiSubscriptionAggregatorRoutes
};
