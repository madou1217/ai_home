'use strict';

// GeoIP 数据资源的 WebUI 路由 —— 全部业务逻辑与 SSE 进度流已迁移至 Go Core，Node 仅作薄代理（零回落）。
//   GET  /v0/webui/geo-resources                   -> GET  /v1/management/webui/geo-resources
//   GET  /v0/webui/geo-resources/jobs              -> GET  /v1/management/webui/geo-resources/jobs
//   POST /v0/webui/geo-resources/jobs              -> POST /v1/management/webui/geo-resources/jobs
//   GET  /v0/webui/geo-resources/jobs/:id          -> GET  /v1/management/webui/geo-resources/jobs/:id
//   GET  /v0/webui/geo-resources/jobs/:id/watch    -> GET  /v1/management/webui/geo-resources/jobs/:id/watch
//   POST /v0/webui/geo-resources/jobs/:id/cancel   -> POST /v1/management/webui/geo-resources/jobs/:id/cancel

const {
  callGoHost,
  proxyWebuiGo,
  resolveGoHost,
  writeGoFailure
} = require('./webui-go-proxy');

const ROOT_PATH = '/v0/webui/geo-resources';
const GO_ROOT_PATH = '/v1/management/webui/geo-resources';
const JOB_PATH_PATTERN = /^\/v0\/webui\/geo-resources\/jobs\/([^/]+)(?:\/(watch|cancel))?$/;

function matchGeoResourceRoute(method, pathname) {
  const verb = String(method || '').toUpperCase();
  const path = String(pathname || '');
  if (verb === 'GET' && path === ROOT_PATH) return true;
  if ((verb === 'POST' || verb === 'GET') && path === `${ROOT_PATH}/jobs`) return true;
  return (verb === 'GET' || verb === 'POST') && JOB_PATH_PATTERN.test(path);
}

async function readJsonBody(ctx) {
  try {
    const raw = typeof ctx.readRequestBody === 'function'
      ? await ctx.readRequestBody(ctx.req, { maxBytes: 8 * 1024 })
      : null;
    const parsed = raw && raw.length ? JSON.parse(raw.toString('utf8')) : {};
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_error) {
    return null;
  }
}

async function pipeGeoJobWatchStream(ctx, jobId) {
  const { req, res, writeJson } = ctx;
  const goHost = resolveGoHost(ctx);
  if (!goHost || typeof goHost.openWebuiStream !== 'function') {
    writeJson(res, 503, {
      ok: false,
      error: 'go_core_unavailable',
      message: 'Go Core 未就绪，GeoIP 任务进度流不可用'
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
      path: `${GO_ROOT_PATH}/jobs/${encodeURIComponent(jobId)}/watch`
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
    writeJson(res, 503, {
      ok: false,
      error: 'go_core_unavailable',
      message: 'Go Core 未就绪，GeoIP 任务进度流不可用'
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
      message: 'Go Core GeoIP 进度流打开失败'
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

async function handleGeoResourceRequest(ctx = {}) {
  const { writeJson, res, req } = ctx;
  const method = String(ctx.method || (req && req.method) || '').toUpperCase();
  const pathname = String(ctx.pathname || '');

  if (method === 'GET' && pathname === ROOT_PATH) {
    return proxyWebuiGo(ctx, {
      method: 'GET',
      path: GO_ROOT_PATH,
      message: 'Go Core 未就绪，无法读取 GeoIP 资源'
    });
  }

  if (pathname === `${ROOT_PATH}/jobs`) {
    if (method === 'GET') {
      return proxyWebuiGo(ctx, {
        method: 'GET',
        path: `${GO_ROOT_PATH}/jobs`,
        message: 'Go Core 未就绪，无法读取 GeoIP 作业'
      });
    }
    const body = await readJsonBody(ctx);
    if (!body) {
      writeJson(res, 400, { ok: false, error: 'invalid_json_body' });
      return true;
    }
    const { available, response } = await callGoHost(ctx, 'webuiRequest', [{
      method: 'POST',
      path: `${GO_ROOT_PATH}/jobs`,
      body
    }]);
    if (!available) {
      writeJson(res, 503, { ok: false, error: 'go_core_unavailable', message: 'Go Core 未就绪，无法创建 GeoIP 作业' });
      return true;
    }
    if (response && response.ok === true && response.data) {
      writeJson(res, Number(response.status) || 200, response.data);
      return true;
    }
    return writeGoFailure(ctx, response, {
      passStatuses: [400, 404, 409],
      message: 'Go Core 未就绪，无法创建 GeoIP 作业'
    });
  }

  const match = JOB_PATH_PATTERN.exec(pathname);
  if (!match) return false;
  let jobId = '';
  try {
    jobId = decodeURIComponent(match[1]).trim();
  } catch (_error) {
    jobId = '';
  }
  if (!jobId) {
    writeJson(res, 400, { ok: false, error: 'invalid_job_id' });
    return true;
  }

  const action = match[2] || '';
  if (method === 'GET' && action === 'watch') {
    return pipeGeoJobWatchStream(ctx, jobId);
  }
  if (method === 'POST' && action === 'cancel') {
    return proxyWebuiGo(ctx, {
      method: 'POST',
      path: `${GO_ROOT_PATH}/jobs/${encodeURIComponent(jobId)}/cancel`,
      message: 'Go Core 未就绪，无法取消 GeoIP 作业'
    });
  }
  return proxyWebuiGo(ctx, {
    method: 'GET',
    path: `${GO_ROOT_PATH}/jobs/${encodeURIComponent(jobId)}`,
    message: 'Go Core 未就绪，无法查询 GeoIP 作业'
  });
}

module.exports = {
  ROOT_PATH,
  handleGeoResourceRequest,
  matchGeoResourceRoute
};
