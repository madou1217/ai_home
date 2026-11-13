'use strict';

// 管理面核心网关路由（/v0/management/*）：
//   - 插件子域（/v0/plugins*）保留前置安全门与分发；
//   - 全部管理、实时监听、用量查询/扫描/渐进看板、重载、冷却清理、重启与状态索引写同步
//     统一经 Go Core（/v1/management/webui/management/*）权威承接，Go 不可用时严格返回
//     503 go_core_unavailable，零 Node 本地计算或降级回退。

const { authorizeManagementKeyOrLoopback } = require('./management-key-auth');
const { handlePluginManagementRequest } = require('./plugin-management-routes');
const { proxyWebuiGo, resolveGoHost } = require('./webui-go-proxy');
const { pipeManagementGoSseStream, handleManagementWatchRequest } = require('./management-live');

const GO_BASE = '/v1/management/webui/management';
const PASS_STATUSES = Object.freeze([400, 404, 405, 409]);

const USAGE_READ_PATHS = new Set([
  '/v0/management/usage',
  '/v0/management/usage/stats',
  '/v0/management/usage/dashboard',
  '/v0/management/usage/models',
  '/v0/management/usage/sessions',
  '/v0/management/usage/requests',
  '/v0/management/usage/breakdown',
  '/v0/management/usage/session-detail'
]);

const STATE_INDEX_PATHS = new Set([
  '/v0/management/state-index/operational-status',
  '/v0/management/state-index/runtime-state',
  '/v0/management/state-index/upsert',
  '/v0/management/state-index/prune-missing'
]);

function normalizeCtx(ctx) {
  const deps = ctx && ctx.deps ? ctx.deps : {};
  const writeJson = typeof (ctx && ctx.writeJson) === 'function'
    ? ctx.writeJson
    : (typeof deps.writeJson === 'function'
      ? deps.writeJson
      : ((res, status, payload) => {
          if (!res || res.destroyed || res.writableEnded) return;
          res.statusCode = status;
          res.setHeader('content-type', 'application/json; charset=utf-8');
          res.end(JSON.stringify(payload));
        }));
  return {
    ...ctx,
    writeJson,
    deps
  };
}

async function readManagementJson(req, ctx) {
  const readRequestBody = (ctx && typeof ctx.readRequestBody === 'function')
    ? ctx.readRequestBody
    : (ctx && ctx.deps && ctx.deps.readRequestBody);
  if (typeof readRequestBody !== 'function') return null;
  const body = await readRequestBody(req, { maxBytes: 1024 * 1024 }).catch(() => null);
  if (!body) return null;
  try {
    return body.length > 0 ? JSON.parse(body.toString('utf8')) : {};
  } catch (_error) {
    return null;
  }
}

async function proxyStatusPageHtml(ctx) {
  const goHost = resolveGoHost(ctx);
  if (!goHost || typeof goHost.openWebuiStream !== 'function') {
    ctx.writeJson(ctx.res, 503, {
      ok: false,
      error: 'go_core_unavailable',
      message: 'Go Core 未就绪，状态页不可用'
    });
    return true;
  }
  let upstream = null;
  try {
    upstream = await goHost.openWebuiStream({
      method: 'GET',
      path: `${GO_BASE}/ui`,
      accept: 'text/html'
    });
  } catch (_error) {
    upstream = null;
  }
  if (!upstream || !upstream.ok) {
    ctx.writeJson(ctx.res, 503, {
      ok: false,
      error: 'go_core_unavailable',
      message: 'Go Core 未就绪，状态页加载失败'
    });
    return true;
  }
  const html = await upstream.text();
  ctx.res.statusCode = 200;
  ctx.res.setHeader('content-type', 'text/html; charset=utf-8');
  ctx.res.setHeader('cache-control', 'no-store');
  ctx.res.end(html);
  return true;
}

async function handleManagementRequest(rawCtx) {
  const ctx = normalizeCtx(rawCtx);
  const {
    method,
    pathname,
    url,
    req,
    res,
    requiredManagementKey,
    deps,
    writeJson
  } = ctx;

  // 插件路由有自己更严格的鉴权（只认管理密钥），先于 /v0/management 的放行逻辑处理。
  if (await handlePluginManagementRequest(ctx)) return true;

  if (!pathname.startsWith('/v0/management')) return false;

  const authorization = authorizeManagementKeyOrLoopback({
    req,
    requiredManagementKey,
    deps: { parseAuthorizationBearer: deps.parseAuthorizationBearer }
  });
  if (!authorization.ok) {
    writeJson(res, authorization.status, authorization.payload);
    return true;
  }

  const query = url && url.search ? url.search : '';

  if (method === 'GET' && pathname === '/v0/management/ui') {
    return proxyStatusPageHtml(ctx);
  }
  if (method === 'GET' && pathname === '/v0/management/watch') {
    return handleManagementWatchRequest(ctx);
  }
  if (method === 'POST' && pathname === '/v0/management/watch/snapshot') {
    return proxyWebuiGo(ctx, {
      method: 'POST',
      path: `${GO_BASE}/watch/snapshot`,
      status: 202,
      passStatuses: PASS_STATUSES,
      message: 'Go Core 未就绪，快照唤醒失败'
    });
  }
  if (method === 'GET' && pathname === '/v0/management/status') {
    return proxyWebuiGo(ctx, {
      method: 'GET',
      path: `${GO_BASE}/status`,
      passStatuses: PASS_STATUSES,
      message: 'Go Core 未就绪，状态读取失败'
    });
  }
  if (method === 'GET' && pathname === '/v0/management/metrics') {
    return proxyWebuiGo(ctx, {
      method: 'GET',
      path: `${GO_BASE}/metrics`,
      passStatuses: PASS_STATUSES,
      message: 'Go Core 未就绪，指标读取失败'
    });
  }
  if (method === 'GET' && pathname === '/v0/management/models') {
    return proxyWebuiGo(ctx, {
      method: 'GET',
      path: `${GO_BASE}/models`,
      query,
      passStatuses: PASS_STATUSES,
      message: 'Go Core 未就绪，模型列表读取失败'
    });
  }
  if (method === 'GET' && pathname === '/v0/management/accounts') {
    return proxyWebuiGo(ctx, {
      method: 'GET',
      path: `${GO_BASE}/accounts`,
      passStatuses: PASS_STATUSES,
      message: 'Go Core 未就绪，账号列表读取失败'
    });
  }

  if (pathname === '/v0/management/usage' || pathname.startsWith('/v0/management/usage/')) {
    if (method === 'GET' && pathname === '/v0/management/usage/dashboard/query/watch') {
      return pipeManagementGoSseStream(ctx, {
        path: `${GO_BASE}/usage/dashboard/query/watch`,
        message: 'Go Core 未就绪，用量查询监听流不可用'
      });
    }
    if (method === 'POST' && pathname === '/v0/management/usage/dashboard/query') {
      return proxyWebuiGo(ctx, {
        method: 'POST',
        path: `${GO_BASE}/usage/dashboard/query`,
        query,
        status: 202,
        passStatuses: PASS_STATUSES,
        message: 'Go Core 未就绪，启动渐进用量查询失败'
      });
    }
    const dashboardQueryJobMatch = pathname.match(/^\/v0\/management\/usage\/dashboard\/query\/([^/]+)$/);
    if (dashboardQueryJobMatch && (method === 'GET' || method === 'DELETE')) {
      return proxyWebuiGo(ctx, {
        method,
        path: `${GO_BASE}/usage/dashboard/query/${dashboardQueryJobMatch[1]}`,
        passStatuses: PASS_STATUSES,
        message: 'Go Core 未就绪，渐进用量查询作业操作失败'
      });
    }
    if (method === 'GET' && pathname === '/v0/management/usage/scan/watch') {
      return pipeManagementGoSseStream(ctx, {
        path: `${GO_BASE}/usage/scan/watch`,
        message: 'Go Core 未就绪，用量扫描监听流不可用'
      });
    }
    if ((method === 'GET' || method === 'POST') && pathname === '/v0/management/usage/scan') {
      return proxyWebuiGo(ctx, {
        method,
        path: `${GO_BASE}/usage/scan`,
        query,
        status: 202,
        passStatuses: PASS_STATUSES,
        message: 'Go Core 未就绪，触发用量扫描失败'
      });
    }
    if (method !== 'GET') {
      writeJson(res, 405, { ok: false, error: 'method_not_allowed' });
      return true;
    }
    if (USAGE_READ_PATHS.has(pathname)) {
      const suffix = pathname.slice('/v0/management'.length);
      return proxyWebuiGo(ctx, {
        method: 'GET',
        path: `${GO_BASE}${suffix}`,
        query,
        passStatuses: PASS_STATUSES,
        message: 'Go Core 未就绪，用量查询失败'
      });
    }
    writeJson(res, 404, { ok: false, error: 'model_usage_not_found' });
    return true;
  }

  if (method === 'POST' && pathname === '/v0/management/reload') {
    return proxyWebuiGo(ctx, {
      method: 'POST',
      path: `${GO_BASE}/reload`,
      passStatuses: PASS_STATUSES,
      message: 'Go Core 未就绪，账号池重载失败'
    });
  }
  if (method === 'POST' && pathname === '/v0/management/cooldown/clear') {
    return proxyWebuiGo(ctx, {
      method: 'POST',
      path: `${GO_BASE}/cooldown/clear`,
      passStatuses: PASS_STATUSES,
      message: 'Go Core 未就绪，清理冷却失败'
    });
  }
  if (method === 'POST' && pathname === '/v0/management/restart') {
    return proxyWebuiGo(ctx, {
      method: 'POST',
      path: `${GO_BASE}/restart`,
      passStatuses: Object.freeze([400, 404, 405, 409, 500]),
      message: 'Go Core 未就绪，服务重启失败'
    });
  }
  if (method === 'POST' && STATE_INDEX_PATHS.has(pathname)) {
    const payload = await readManagementJson(req, ctx);
    if (!payload) {
      writeJson(res, 400, { ok: false, error: 'invalid_state_index_payload' });
      return true;
    }
    const suffix = pathname.slice('/v0/management'.length);
    return proxyWebuiGo(ctx, {
      method: 'POST',
      path: `${GO_BASE}${suffix}`,
      body: payload,
      passStatuses: PASS_STATUSES,
      message: 'Go Core 未就绪，状态索引同步失败'
    });
  }

  writeJson(res, 404, { ok: false, error: 'management_not_found' });
  return true;
}

module.exports = {
  handleManagementRequest
};
