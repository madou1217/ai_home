'use strict';

// 管理面实时 SSE 与快照唤醒已统一由 Go Core（/v1/management/webui/management/watch*）承接。
// 本模块仅保留与 web-ui-router / management-router 兼容的薄 Go 转发与 fail-closed 护栏，
// 不再维护任何 Node 本地轮询器、SSE 客户端集合或本地快照状态。

const { resolveGoHost } = require('./webui-go-proxy');

const GO_WATCH_PATH = '/v1/management/webui/management/watch';
const GO_WATCH_SNAPSHOT_PATH = '/v1/management/webui/management/watch/snapshot';

function resolveWriteJson(ctx) {
  if (ctx && typeof ctx.writeJson === 'function') return ctx.writeJson;
  if (ctx && ctx.deps && typeof ctx.deps.writeJson === 'function') return ctx.deps.writeJson;
  return (res, status, payload) => {
    if (!res || res.destroyed || res.writableEnded) return;
    res.statusCode = status;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(payload));
  };
}

function resolveAnyGoHost(ctx) {
  const fromProxy = resolveGoHost(ctx);
  if (fromProxy) return fromProxy;
  if (ctx && ctx.goCoreSync && typeof ctx.goCoreSync === 'object') return ctx.goCoreSync;
  return null;
}

function writeGoSseUnavailable(res, writeJson, status, payload, message) {
  writeJson(res, status, payload || {
    ok: false,
    error: 'go_core_unavailable',
    message: String(message || 'Go Core 未就绪，SSE 监听流不可用')
  });
  return true;
}

/**
 * 把 Go Core 的 /v1/management/webui/... SSE 流直接透传到客户端；Go 不可用时显式返回 503 go_core_unavailable。
 */
async function pipeManagementGoSseStream(ctx, options = {}) {
  const { req, res } = ctx || {};
  const writeJson = resolveWriteJson(ctx);
  const path = String(options.path || '').trim();
  const message = String(options.message || 'Go Core 未就绪，管理监听流不可用');
  const goHost = resolveAnyGoHost(ctx);
  if (!path || !goHost || typeof goHost.openWebuiStream !== 'function') {
    return writeGoSseUnavailable(res, writeJson, 503, null, message);
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
      path,
      query: options.query ? String(options.query) : ''
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
    return writeGoSseUnavailable(res, writeJson, 503, null, message);
  }

  if (!upstream.ok || !upstream.body) {
    const text = typeof upstream.text === 'function' ? await upstream.text().catch(() => '') : '';
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch (_error) { payload = null; }
    const status = Number(upstream.status) || 503;
    return writeGoSseUnavailable(
      res,
      writeJson,
      status >= 500 ? 503 : status,
      payload,
      message
    );
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
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

async function handleManagementWatchRequest(ctx) {
  return pipeManagementGoSseStream(ctx, {
    path: GO_WATCH_PATH,
    message: 'Go Core 未就绪，管理面实时监听不可用'
  });
}

function notifyManagementWatchers(ctx) {
  const goHost = resolveAnyGoHost(ctx);
  if (!goHost || typeof goHost.webuiRequest !== 'function') {
    return false;
  }
  Promise.resolve(goHost.webuiRequest({
    method: 'POST',
    path: GO_WATCH_SNAPSHOT_PATH
  })).catch(() => {});
  return true;
}

function emitManagementLiveEvent() {
  return false;
}

module.exports = {
  pipeManagementGoSseStream,
  handleManagementWatchRequest,
  notifyManagementWatchers,
  emitManagementLiveEvent
};
