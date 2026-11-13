'use strict';

// GET /v0/webui/peer/messages*：`aih peer` 只读消息投影与变更 watch 代理。
// 数据读取、状态统计与目录监听全部在 Go（webuipeerapi + internal/runtime/peer），
// Node 只保留薄代理；Go 未就绪时显式返回 503，绝不回落到本地扫描。

const { proxyWebuiGo, resolveGoHost } = require('./webui-go-proxy');

const PEER_MESSAGES_ROUTE = '/v0/webui/peer/messages';
const PEER_WATCH_ROUTE = '/v0/webui/peer/messages/watch';
const GO_PEER_PREFIX = '/v1/management/webui/peer/messages';

function writeJson(ctx, status, payload) {
  if (typeof ctx.writeJson === 'function') {
    ctx.writeJson(ctx.res, status, payload);
    return;
  }
  ctx.res.writeHead(status, { 'Content-Type': 'application/json' });
  ctx.res.end(JSON.stringify(payload));
}

function withWriteJson(ctx) {
  if (ctx && typeof ctx.writeJson === 'function') return ctx;
  return { ...ctx, writeJson: (res, status, payload) => writeJson({ res }, status, payload) };
}

function readQueryString(ctx) {
  if (ctx && ctx.url && typeof ctx.url.search === 'string') {
    return ctx.url.search.replace(/^\?/, '');
  }
  const raw = String((ctx && ctx.req && ctx.req.url) || '');
  const idx = raw.indexOf('?');
  return idx >= 0 ? raw.slice(idx + 1) : '';
}

async function handlePeerWatch(ctx) {
  const { req, res } = ctx;
  const goHost = resolveGoHost(ctx);
  if (!goHost || typeof goHost.openWebuiStream !== 'function') {
    writeJson(ctx, 503, {
      ok: false,
      error: 'go_core_unavailable',
      message: 'Go Core 未就绪，peer 监听不可用'
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
      path: `${GO_PEER_PREFIX}/watch`,
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
    writeJson(ctx, 503, {
      ok: false,
      error: 'go_core_unavailable',
      message: 'Go Core 未就绪，peer 监听不可用'
    });
    return true;
  }

  if (!upstream.ok || !upstream.body) {
    const text = typeof upstream.text === 'function' ? await upstream.text().catch(() => '') : '';
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch (_error) { payload = null; }
    writeJson(ctx, Number(upstream.status) || 502, payload || { ok: false, error: 'peer_store_unavailable' });
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

async function handleWebUiPeerRoutes(ctx = {}) {
  const { method, pathname } = ctx;
  if (method !== 'GET' || (pathname !== PEER_MESSAGES_ROUTE && pathname !== PEER_WATCH_ROUTE)) {
    return false;
  }
  if (pathname === PEER_WATCH_ROUTE) {
    return handlePeerWatch(ctx);
  }
  return proxyWebuiGo(withWriteJson(ctx), {
    method: 'GET',
    path: GO_PEER_PREFIX,
    query: readQueryString(ctx),
    passStatuses: [400, 404, 409, 503],
    message: 'Go Core 未就绪，peer 消息不可读'
  });
}

module.exports = { handleWebUiPeerRoutes };
