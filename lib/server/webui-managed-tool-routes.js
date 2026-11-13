'use strict';

// 受管网络工具作业路由（plan / execute / jobs / watch / cancel）——
// 全部业务逻辑、作业状态机与 SSE 事件流已迁至 Go Core（零回落）。

const { proxyWebuiGo, resolveGoHost } = require('./webui-go-proxy');

const GO_TOOLS_PREFIX = '/v1/management/webui/toolkit/tools';
const TOOL_PASS_STATUSES = [400, 404, 405, 409, 413, 428, 500, 502, 504];

function buildRouteCtx(ctx = {}, req, res, method, pathname) {
  const targetRes = res || ctx.res;
  const writeJson = typeof ctx.writeJson === 'function'
    ? ctx.writeJson
    : (response, status, payload) => {
        response.writeHead(status, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        });
        response.end(JSON.stringify(payload));
      };
  return {
    ...ctx,
    req: req || ctx.req,
    res: targetRes,
    method: method || ctx.method || (req && req.method),
    pathname: pathname || ctx.pathname,
    writeJson
  };
}

function readRequestStream(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      const buffer = Buffer.from(chunk);
      size += buffer.length;
      if (size > maxBytes) {
        const err = new Error('Body too large');
        err.code = 'request_body_too_large';
        try { req.destroy(); } catch (_error) {}
        reject(err);
        return;
      }
      chunks.push(buffer);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJsonBody(ctx, options = {}) {
  const maxBytes = Number(options.maxBytes) > 0 ? Number(options.maxBytes) : 64 * 1024;
  const invalidCode = String(options.invalidCode || 'invalid_request_body');
  const invalidMessage = String(options.invalidMessage || '请求参数无效。');
  let buffer = null;
  try {
    buffer = typeof ctx.readRequestBody === 'function'
      ? await ctx.readRequestBody(ctx.req, { maxBytes })
      : await readRequestStream(ctx.req, maxBytes);
  } catch (error) {
    if (error && (error.code === 'request_body_too_large' || error.message === 'Body too large')) {
      ctx.writeJson(ctx.res, 413, { ok: false, error: 'body_too_large', message: 'Body too large' });
      return null;
    }
    ctx.writeJson(ctx.res, 400, { ok: false, error: invalidCode, message: invalidMessage });
    return null;
  }
  const text = buffer ? buffer.toString('utf8').trim() : '';
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (_error) {
    ctx.writeJson(ctx.res, 400, { ok: false, error: invalidCode, message: invalidMessage });
    return null;
  }
}

async function pipeWebuiSseStream(ctx, goPath, unavailableMessage) {
  const { req, res, writeJson } = ctx;
  const goHost = resolveGoHost(ctx);
  if (!goHost || typeof goHost.openWebuiStream !== 'function') {
    writeJson(res, 503, {
      ok: false,
      error: 'go_core_unavailable',
      message: unavailableMessage
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
      path: goPath,
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
    writeJson(res, 503, {
      ok: false,
      error: 'go_core_unavailable',
      message: unavailableMessage
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
      message: unavailableMessage
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
          const finish = () => {
            res.off('drain', finish);
            res.off('close', finish);
            res.off('error', finish);
            resolve();
          };
          res.once('drain', finish);
          res.once('close', finish);
          res.once('error', finish);
        });
      }
    }
  } catch (_error) {
    // 客户端断开或 Go 上游事件流结束。
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

function parseJobPath(pathname) {
  const matches = String(pathname || '').match(/^\/v0\/webui\/toolkit\/tools\/jobs\/([^/]+)(?:\/(watch|cancel))?$/);
  if (!matches) return null;
  try {
    return { jobId: decodeURIComponent(matches[1]), action: matches[2] || '' };
  } catch (_error) {
    return { invalid: true };
  }
}

async function handleWebUiManagedToolRoutes(req, res, method, pathname, ctx = {}) {
  const routeCtx = buildRouteCtx(ctx, req, res, method, pathname);

  if (method === 'POST' && pathname === '/v0/webui/toolkit/tools/plan') {
    const body = await readJsonBody(routeCtx, {
      invalidCode: 'invalid_managed_tool_payload',
      invalidMessage: '网络工具参数无效。'
    });
    if (body === null) return true;
    return proxyWebuiGo(routeCtx, {
      method: 'POST',
      path: `${GO_TOOLS_PREFIX}/plan`,
      body,
      passStatuses: TOOL_PASS_STATUSES,
      message: 'Go Core 未就绪，无法生成网络工具计划'
    });
  }

  if (method === 'POST' && pathname === '/v0/webui/toolkit/tools/execute') {
    const body = await readJsonBody(routeCtx, {
      invalidCode: 'invalid_managed_tool_payload',
      invalidMessage: '网络工具参数无效。'
    });
    if (body === null) return true;
    return proxyWebuiGo(routeCtx, {
      method: 'POST',
      path: `${GO_TOOLS_PREFIX}/execute`,
      body,
      status: 202,
      passStatuses: TOOL_PASS_STATUSES,
      message: 'Go Core 未就绪，无法执行网络工具操作'
    });
  }

  if (method === 'GET' && pathname === '/v0/webui/toolkit/tools/jobs') {
    return proxyWebuiGo(routeCtx, {
      method: 'GET',
      path: `${GO_TOOLS_PREFIX}/jobs`,
      passStatuses: TOOL_PASS_STATUSES,
      message: 'Go Core 未就绪，无法读取网络工具任务'
    });
  }

  const parsed = parseJobPath(pathname);
  if (!parsed) return false;
  if (parsed.invalid) {
    routeCtx.writeJson(routeCtx.res, 400, {
      ok: false,
      error: 'invalid_job_path',
      message: '网络工具任务路径无效。'
    });
    return true;
  }

  const jobPath = `${GO_TOOLS_PREFIX}/jobs/${encodeURIComponent(parsed.jobId)}`;
  if (method === 'GET' && parsed.action === 'watch') {
    return pipeWebuiSseStream(routeCtx, `${jobPath}/watch`, 'Go Core 未就绪，网络工具任务事件流不可用');
  }
  if (method === 'GET' && !parsed.action) {
    return proxyWebuiGo(routeCtx, {
      method: 'GET',
      path: jobPath,
      passStatuses: TOOL_PASS_STATUSES,
      message: 'Go Core 未就绪，无法读取网络工具任务'
    });
  }
  if (method === 'POST' && parsed.action === 'cancel') {
    return proxyWebuiGo(routeCtx, {
      method: 'POST',
      path: `${jobPath}/cancel`,
      passStatuses: TOOL_PASS_STATUSES,
      message: 'Go Core 未就绪，无法取消网络工具任务'
    });
  }

  routeCtx.writeJson(routeCtx.res, 400, {
    ok: false,
    error: 'unsupported_managed_tool_job_action',
    message: '不支持的网络工具任务操作。'
  });
  return true;
}

module.exports = {
  buildRouteCtx,
  handleWebUiManagedToolRoutes,
  parseJobPath,
  pipeWebuiSseStream,
  readJsonBody
};
