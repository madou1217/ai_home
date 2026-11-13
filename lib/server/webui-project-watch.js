'use strict';

// WebUI 项目 SSE 监听与快照触发统一透传 Go Core（零 Node 轮询/fs.watch 回落）：
//   GET  /v0/webui/projects/watch          → GET  /v1/management/webui/projects/watch
//   POST /v0/webui/projects/watch/snapshot → POST /v1/management/webui/projects/watch/snapshot

const { proxyWebuiGo, resolveGoHost } = require('./webui-go-proxy');

const GO_PROJECT_WATCH_PATH = '/v1/management/webui/projects/watch';
const GO_PROJECT_SNAPSHOT_PATH = '/v1/management/webui/projects/watch/snapshot';

function readQueryString(ctx) {
  if (ctx && ctx.url && ctx.url.searchParams) {
    return ctx.url.searchParams.toString();
  }
  const rawUrl = String((ctx && ctx.req && ctx.req.url) || '');
  const qIndex = rawUrl.indexOf('?');
  return qIndex >= 0 ? rawUrl.slice(qIndex + 1) : '';
}

async function handleWebUiProjectsWatchRequest(ctx) {
  const { req, res, writeJson } = ctx;
  const goHost = resolveGoHost(ctx);
  if (!goHost || typeof goHost.openWebuiStream !== 'function') {
    writeJson(res, 503, {
      ok: false,
      error: 'go_core_unavailable',
      message: 'Go Core 未就绪，项目监听不可用'
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
  req.on('close', abort);
  res.on('close', abort);
  res.on('error', abort);

  let upstream = null;
  try {
    upstream = await goHost.openWebuiStream({
      path: GO_PROJECT_WATCH_PATH,
      query: readQueryString(ctx)
    });
  } catch (_error) {
    upstream = null;
  }

  if (closed || req.destroyed || res.destroyed || res.writableEnded) {
    if (upstream && upstream.body && typeof upstream.body.cancel === 'function') {
      try { await upstream.body.cancel(); } catch (_error) {}
    }
    return true;
  }

  if (!upstream) {
    writeJson(res, 503, {
      ok: false,
      error: 'go_core_unavailable',
      message: 'Go Core 未就绪，项目监听不可用'
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
      message: 'Go Core 项目监听流打开失败'
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
    // 客户端或 Go 上游断开后直接结束 SSE 管道。
  } finally {
    abort();
    req.off('close', abort);
    res.off('close', abort);
    res.off('error', abort);
    if (!res.destroyed && !res.writableEnded) {
      try { res.end(); } catch (_error) {}
    }
  }
  return true;
}

async function notifyWebUiProjectWatchers(ctx) {
  const goHost = resolveGoHost(ctx);
  if (!goHost || typeof goHost.webuiRequest !== 'function') {
    return false;
  }
  try {
    const response = await goHost.webuiRequest({
      method: 'POST',
      path: GO_PROJECT_SNAPSHOT_PATH
    });
    return Boolean(response && response.ok);
  } catch (_error) {
    return false;
  }
}

async function handleWebUiProjectsSnapshotRequest(ctx) {
  return proxyWebuiGo(ctx, {
    method: 'POST',
    path: GO_PROJECT_SNAPSHOT_PATH,
    status: 202,
    passStatuses: [400, 404, 409, 500],
    message: 'Go Core 未就绪，无法刷新项目快照'
  });
}

module.exports = {
  handleWebUiProjectsWatchRequest,
  handleWebUiProjectsSnapshotRequest,
  notifyWebUiProjectWatchers
};
