'use strict';

// 受管工具后台服务控制路由 —— 全部逻辑已迁至 Go Core（零回落）。

const { proxyWebuiGo } = require('./webui-go-proxy');
const { buildRouteCtx, readJsonBody } = require('./webui-managed-tool-routes');

const SERVICE_PATH = /^\/v0\/webui\/toolkit\/tools\/([^/]+)\/service(?:\/(settings|config|logs))?$/;
const SERVICE_PASS_STATUSES = [400, 404, 405, 409, 413, 428, 500, 502];

function parseServicePath(pathname) {
  const match = String(pathname || '').match(SERVICE_PATH);
  if (!match) return null;
  try {
    return { toolId: decodeURIComponent(match[1]), sub: match[2] || '' };
  } catch (_error) {
    return { invalid: true };
  }
}

function readQueryString(ctx, req) {
  if (ctx && ctx.url && ctx.url.searchParams) {
    return ctx.url.searchParams.toString();
  }
  const rawUrl = String((req && req.url) || '');
  const qIndex = rawUrl.indexOf('?');
  return qIndex >= 0 ? rawUrl.slice(qIndex + 1) : '';
}

async function handleWebUiToolServiceRoutes(req, res, method, pathname, ctx = {}) {
  const parsed = parseServicePath(pathname);
  if (!parsed) return false;
  const routeCtx = buildRouteCtx(ctx, req, res, method, pathname);
  if (parsed.invalid) {
    routeCtx.writeJson(routeCtx.res, 400, {
      ok: false,
      error: 'invalid_service_path',
      message: '服务路径无效。'
    });
    return true;
  }

  const basePath = `/v1/management/webui/toolkit/tools/${encodeURIComponent(parsed.toolId)}/service`;
  if (!parsed.sub && method === 'GET') {
    return proxyWebuiGo(routeCtx, {
      method: 'GET',
      path: basePath,
      passStatuses: SERVICE_PASS_STATUSES,
      message: 'Go Core 未就绪，无法读取工具服务状态'
    });
  }
  if (!parsed.sub && method === 'POST') {
    const body = await readJsonBody(routeCtx, {
      invalidCode: 'invalid_service_payload',
      invalidMessage: '服务操作参数无效。'
    });
    if (body === null) return true;
    return proxyWebuiGo(routeCtx, {
      method: 'POST',
      path: basePath,
      body,
      passStatuses: SERVICE_PASS_STATUSES,
      message: 'Go Core 未就绪，无法控制工具服务'
    });
  }
  if (parsed.sub === 'settings' && method === 'PUT') {
    const body = await readJsonBody(routeCtx, {
      invalidCode: 'invalid_service_payload',
      invalidMessage: '服务设置参数无效。'
    });
    if (body === null) return true;
    return proxyWebuiGo(routeCtx, {
      method: 'PUT',
      path: `${basePath}/settings`,
      body,
      passStatuses: SERVICE_PASS_STATUSES,
      message: 'Go Core 未就绪，无法保存工具服务设置'
    });
  }
  if (parsed.sub === 'config' && method === 'POST') {
    return proxyWebuiGo(routeCtx, {
      method: 'POST',
      path: `${basePath}/config`,
      passStatuses: SERVICE_PASS_STATUSES,
      message: 'Go Core 未就绪，无法初始化服务配置'
    });
  }
  if (parsed.sub === 'logs' && method === 'GET') {
    return proxyWebuiGo(routeCtx, {
      method: 'GET',
      path: `${basePath}/logs`,
      query: readQueryString(routeCtx, req),
      passStatuses: SERVICE_PASS_STATUSES,
      message: 'Go Core 未就绪，无法读取工具服务日志'
    });
  }

  routeCtx.writeJson(routeCtx.res, 400, {
    ok: false,
    error: 'unsupported_service_route',
    message: '不支持的服务操作。'
  });
  return true;
}

module.exports = {
  handleWebUiToolServiceRoutes,
  parseServicePath
};
