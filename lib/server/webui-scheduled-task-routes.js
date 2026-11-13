'use strict';

// **WebUI 数据面：计划任务**（薄代理到 Go webuischeduledtasksapi，Node 零本地逻辑/回退）。

const { proxyWebuiGo } = require('./webui-go-proxy');

const TASKS_ROUTE = '/v0/webui/scheduled-tasks';
const RECORDS_ROUTE = '/v0/webui/scheduled-tasks/records';
const PREVIEW_ROUTE = '/v0/webui/scheduled-tasks/preview';
const TASK_ACTION_ROUTE = /^\/v0\/webui\/scheduled-tasks\/([A-Za-z0-9._:-]{1,128})\/(run|toggle|delete)$/;
const GO_PREFIX = '/v1/management/webui/scheduled-tasks';

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

async function readJsonBody(ctx) {
  const readRequestBody = ctx.readRequestBody || (ctx.deps && ctx.deps.readRequestBody);
  if (typeof readRequestBody !== 'function') return null;
  try {
    const body = await readRequestBody(ctx.req, { maxBytes: 64 * 1024 });
    return body && body.length > 0 ? JSON.parse(body.toString('utf8')) : {};
  } catch (_error) {
    return null;
  }
}

function readRecordsQueryString(ctx) {
  if (ctx && ctx.url && typeof ctx.url.search === 'string' && ctx.url.search) {
    return ctx.url.search.replace(/^\?/, '');
  }
  const raw = String((ctx && ctx.req && ctx.req.url) || '');
  const idx = raw.indexOf('?');
  if (idx >= 0) return raw.slice(idx + 1);
  if (ctx && ctx.query && typeof ctx.query === 'object') {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(ctx.query)) {
      if (v !== undefined && v !== null && String(v) !== '') {
        params.set(k, String(v));
      }
    }
    return params.toString();
  }
  return '';
}

async function handleWebUiScheduledTaskRoutes(ctx = {}) {
  const { method, pathname } = ctx;
  if (pathname !== TASKS_ROUTE && pathname !== RECORDS_ROUTE && pathname !== PREVIEW_ROUTE
    && !TASK_ACTION_ROUTE.test(pathname)) {
    return false;
  }
  const routeCtx = withWriteJson(ctx);

  if (pathname === TASKS_ROUTE && method === 'GET') {
    return proxyWebuiGo(routeCtx, {
      method: 'GET',
      path: GO_PREFIX,
      passStatuses: [400, 404, 409, 503],
      message: 'Go Core 未就绪，计划任务不可读'
    });
  }
  if (pathname === TASKS_ROUTE && method === 'POST') {
    const body = await readJsonBody(ctx);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      writeJson(ctx, 400, { ok: false, error: 'invalid_body' });
      return true;
    }
    return proxyWebuiGo(routeCtx, {
      method: 'POST',
      path: GO_PREFIX,
      body,
      passStatuses: [400, 404, 409, 503],
      message: 'Go Core 未就绪，计划任务不可写'
    });
  }
  if (pathname === RECORDS_ROUTE && method === 'GET') {
    return proxyWebuiGo(routeCtx, {
      method: 'GET',
      path: `${GO_PREFIX}/records`,
      query: readRecordsQueryString(ctx),
      passStatuses: [400, 404, 409, 503],
      message: 'Go Core 未就绪，计划任务运行记录不可读'
    });
  }
  if (pathname === PREVIEW_ROUTE && method === 'POST') {
    const body = await readJsonBody(ctx);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      writeJson(ctx, 400, { ok: false, error: 'invalid_body' });
      return true;
    }
    return proxyWebuiGo(routeCtx, {
      method: 'POST',
      path: `${GO_PREFIX}/preview`,
      body,
      passStatuses: [400, 404, 409, 503],
      message: 'Go Core 未就绪，调度预览不可用'
    });
  }

  const match = TASK_ACTION_ROUTE.exec(pathname);
  if (match) {
    if (method !== 'POST') {
      writeJson(ctx, 405, { ok: false, error: 'method_not_allowed' });
      return true;
    }
    const taskId = match[1];
    const action = match[2];
    let body;
    if (action === 'toggle') {
      body = await readJsonBody(ctx);
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        writeJson(ctx, 400, { ok: false, error: 'invalid_body' });
        return true;
      }
    }
    return proxyWebuiGo(routeCtx, {
      method: 'POST',
      path: `${GO_PREFIX}/${encodeURIComponent(taskId)}/${action}`,
      body,
      status: action === 'run' ? 202 : 200,
      passStatuses: [400, 404, 409, 503],
      message: 'Go Core 未就绪，计划任务操作不可用'
    });
  }

  writeJson(ctx, 405, { ok: false, error: 'method_not_allowed' });
  return true;
}

module.exports = {
  TASKS_ROUTE,
  RECORDS_ROUTE,
  TASK_ACTION_ROUTE,
  handleWebUiScheduledTaskRoutes
};
