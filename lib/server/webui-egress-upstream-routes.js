'use strict';

// WebUI「上游」地区策略与网络判定路由 —— 全部业务逻辑与 SSE 监听已迁至 Go Core（零回落）。
//   GET  /v0/webui/egress-upstreams                  -> GET  /v1/management/webui/egress-upstreams
//   GET  /v0/webui/egress-upstreams/watch            -> GET  /v1/management/webui/egress-upstreams/watch
//   POST /v0/webui/egress-upstreams/network/refresh  -> POST /v1/management/webui/egress-upstreams/network/refresh
//   PUT  /v0/webui/egress-upstreams/:id              -> PUT  /v1/management/webui/egress-upstreams/:id
//   POST /v0/webui/egress-upstreams/:id/probe        -> POST /v1/management/webui/egress-upstreams/:id/probe
//   POST /v0/webui/egress-upstreams/:id/evidence/reset -> POST /v1/management/webui/egress-upstreams/:id/evidence/reset

const {
  callGoHost,
  proxyWebuiGo,
  resolveGoHost,
  writeGoFailure
} = require('./webui-go-proxy');

const ROOT = '/v0/webui/egress-upstreams';
const GO_ROOT = '/v1/management/webui/egress-upstreams';
const ITEM = /^\/v0\/webui\/egress-upstreams\/([^/]+)$/;
const ACTION = /^\/v0\/webui\/egress-upstreams\/([^/]+)\/(probe|evidence\/reset)$/;

function matchEgressUpstreamRoute(method, pathname) {
  const verb = String(method || '').toUpperCase();
  const path = String(pathname || '');
  if (verb === 'GET' && path === ROOT) return true;
  if (verb === 'GET' && path === `${ROOT}/watch`) return true;
  if (verb === 'POST' && path === `${ROOT}/network/refresh`) return true;
  if (verb === 'PUT' && ITEM.test(path)) return true;
  return verb === 'POST' && ACTION.test(path);
}

function readQueryString(ctx) {
  if (ctx && ctx.url && ctx.url.searchParams) {
    return ctx.url.searchParams.toString();
  }
  const rawUrl = String((ctx && ctx.req && ctx.req.url) || '');
  const qIndex = rawUrl.indexOf('?');
  return qIndex >= 0 ? rawUrl.slice(qIndex + 1) : '';
}

async function readJsonBody(ctx) {
  try {
    const body = typeof ctx.readRequestBody === 'function'
      ? await ctx.readRequestBody(ctx.req, { maxBytes: 64 * 1024 })
      : null;
    const parsed = body && body.length ? JSON.parse(body.toString('utf8')) : {};
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_error) {
    return null;
  }
}

function decodeRawId(raw) {
  try {
    return decodeURIComponent(raw).trim();
  } catch (_error) {
    return '';
  }
}

async function pipeEgressUpstreamsWatch(ctx) {
  const { req, res, writeJson } = ctx;
  const goHost = resolveGoHost(ctx);
  if (!goHost || typeof goHost.openWebuiStream !== 'function') {
    writeJson(res, 503, {
      ok: false,
      error: 'go_core_unavailable',
      message: 'Go Core 未就绪，上游策略监听流不可用'
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
    upstream = await goHost.openWebuiStream({ path: `${GO_ROOT}/watch` });
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
    writeJson(res, 503, {
      ok: false,
      error: 'go_core_unavailable',
      message: 'Go Core 未就绪，上游策略监听流不可用'
    });
    return true;
  }

  if (!upstream.ok || !upstream.body) {
    const text = typeof upstream.text === 'function' ? await upstream.text().catch(() => '') : '';
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch (_error) { payload = null; }
    writeJson(res, Number(upstream.status) || 502, payload || {
      ok: false,
      error: 'go_core_unavailable',
      message: 'Go Core 上游策略监听流打开失败'
    });
    return true;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }

  reader = upstream.body.getReader();
  try {
    while (!closed) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.length === 0) continue;
      if (!res.write(Buffer.from(value))) {
        await new Promise((resolve) => {
          const doneWait = () => {
            res.off('drain', doneWait);
            res.off('close', doneWait);
            res.off('error', doneWait);
            resolve();
          };
          res.once('drain', doneWait);
          res.once('close', doneWait);
          res.once('error', doneWait);
        });
      }
    }
  } catch (_error) {
    // 客户端或 Go 上游断开后结束 SSE 管道。
  } finally {
    abort();
    if (req && typeof req.off === 'function') req.off('close', abort);
    if (res && typeof res.off === 'function') {
      res.off('close', abort);
      res.off('error', abort);
    }
    if (res && !res.destroyed && !res.writableEnded) {
      try { res.end(); } catch (_error) {}
    }
  }
  return true;
}

async function handleEgressUpstreamRequest(ctx = {}) {
  const { writeJson, res, req } = ctx;
  const method = String(ctx.method || (req && req.method) || '').toUpperCase();
  const pathname = String(ctx.pathname || '');

  if (method === 'GET' && pathname === `${ROOT}/watch`) {
    return pipeEgressUpstreamsWatch(ctx);
  }

  if (method === 'GET') {
    return proxyWebuiGo(ctx, {
      method: 'GET',
      path: GO_ROOT,
      query: readQueryString(ctx),
      message: 'Go Core 未就绪，无法读取上游策略'
    });
  }

  if (pathname === `${ROOT}/network/refresh`) {
    return proxyWebuiGo(ctx, {
      method: 'POST',
      path: `${GO_ROOT}/network/refresh`,
      passStatuses: [400, 404, 409, 502],
      message: 'Go Core 未就绪，无法刷新网络出口位置'
    });
  }

  const body = await readJsonBody(ctx);
  if (!body) {
    writeJson(res, 400, { ok: false, error: 'invalid_json_body' });
    return true;
  }

  if (method === 'PUT') {
    const id = decodeRawId(ITEM.exec(pathname)[1]);
    if (!id) {
      writeJson(res, 400, { ok: false, error: 'invalid_upstream_id' });
      return true;
    }
    return proxyWebuiGo(ctx, {
      method: 'PUT',
      path: `${GO_ROOT}/${encodeURIComponent(id)}`,
      body,
      passStatuses: [400, 404, 409, 500],
      message: 'Go Core 未就绪，无法更新上游策略'
    });
  }

  const match = ACTION.exec(pathname);
  if (!match) return false;
  const id = decodeRawId(match[1]);
  if (!id) {
    writeJson(res, 404, { ok: false, error: 'upstream_not_found' });
    return true;
  }

  if (match[2] === 'evidence/reset') {
    return proxyWebuiGo(ctx, {
      method: 'POST',
      path: `${GO_ROOT}/${encodeURIComponent(id)}/evidence/reset`,
      body,
      message: 'Go Core 未就绪，无法重置实测记录'
    });
  }

  const { available, response } = await callGoHost(ctx, 'webuiRequest', [{
    method: 'POST',
    path: `${GO_ROOT}/${encodeURIComponent(id)}/probe`,
    body
  }]);
  if (!available) {
    writeJson(res, 503, { ok: false, error: 'go_core_unavailable', message: 'Go Core 未就绪，无法探测上游节点' });
    return true;
  }
  if (response && response.ok === true && response.data) {
    writeJson(res, Number(response.status) || 200, response.data);
    return true;
  }
  return writeGoFailure(ctx, response, {
    passStatuses: [400, 404, 409],
    message: 'Go Core 未就绪，无法探测上游节点'
  });
}

module.exports = {
  handleEgressUpstreamRequest,
  matchEgressUpstreamRoute
};
