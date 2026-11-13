'use strict';

// GET /v0/webui/tasks*：全局活跃任务队列与 SSE watch 代理。
// 任务聚合与订阅中心都在 Go（webuitasksapi + internal/runtime/taskhub），Node 零回退。

const { proxyWebuiGo, resolveGoHost } = require('./webui-go-proxy');

const TASKS_ROUTE = '/v0/webui/tasks';
const TASKS_WATCH_ROUTE = '/v0/webui/tasks/watch';
const GO_TASKS_PATH = '/v1/management/webui/tasks';

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

async function handleTasksWatch(ctx) {
  const { req, res } = ctx;
  const goHost = resolveGoHost(ctx);
  if (!goHost || typeof goHost.openWebuiStream !== 'function') {
    writeJson(ctx, 503, {
      ok: false,
      error: 'go_core_unavailable',
      message: 'Go Core 未就绪，任务队列监听不可用'
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
      path: `${GO_TASKS_PATH}/watch`,
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
      message: 'Go Core 未就绪，任务队列监听不可用'
    });
    return true;
  }

  if (!upstream.ok || !upstream.body) {
    const text = typeof upstream.text === 'function' ? await upstream.text().catch(() => '') : '';
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch (_error) { payload = null; }
    writeJson(ctx, Number(upstream.status) || 502, payload || { ok: false, error: 'task_hub_unavailable' });
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

async function handleWebUiTaskRoutes(ctx = {}) {
  const { method, pathname } = ctx;
  if (pathname !== TASKS_ROUTE && pathname !== TASKS_WATCH_ROUTE) return false;
  if (method !== 'GET') {
    writeJson(ctx, 405, { ok: false, error: 'method_not_allowed' });
    return true;
  }
  if (pathname === TASKS_WATCH_ROUTE) {
    return handleTasksWatch(ctx);
  }
  return proxyWebuiGo(withWriteJson(ctx), {
    method: 'GET',
    path: GO_TASKS_PATH,
    passStatuses: [400, 404, 409, 503],
    message: 'Go Core 未就绪，任务队列不可读'
  });
}

module.exports = {
  handleWebUiTaskRoutes
};
