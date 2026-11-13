'use strict';

// WebUI Toolkit 核心路由（镜像 / 代理 / 连通性 / 受管工具 / 受管应用配置与启停）——
// 全部业务逻辑已迁至 Go Core（零回落）；Node 仅保留既有子路由委派与 open 的客户端传输策略判定。

const { proxyWebuiGo } = require('./webui-go-proxy');
const { defaultWebTerminalSessionKey, resolveTerminalTransport } = require('./webui-terminal-transport-policy');
const { handleWebUiSubscriptionAggregatorRoutes } = require('./webui-subscription-aggregator-routes');
const { handleWebUiEdgeProxyRoutes } = require('./webui-edge-proxy-routes');
const { handleWebUiManagedToolRoutes, buildRouteCtx, readJsonBody } = require('./webui-managed-tool-routes');
const { handleWebUiToolServiceRoutes } = require('./webui-tool-service-routes');
const { handleWebUiProviderConfigRoutes } = require('./webui-provider-config-routes');
const { handleWebUiToolAppSettingsRoutes } = require('./webui-tool-app-settings-routes');

const CONFIG_BODY_MAX_BYTES = 3 * 1024 * 1024;
const TOOLKIT_PASS_STATUSES = [400, 403, 404, 405, 409, 413, 422, 428, 500, 501, 502, 503, 504];

function resolveSegmentId(pathname, prefix, suffix) {
  if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) return '';
  const encoded = pathname.slice(prefix.length, -suffix.length);
  if (!encoded || encoded.includes('/')) return '';
  try {
    return decodeURIComponent(encoded);
  } catch (_error) {
    return null;
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

function decodeMatchSegment(raw, invalidError) {
  try {
    return decodeURIComponent(raw);
  } catch (_error) {
    return { invalidError };
  }
}

async function handleWebUiToolkitRoutes(req, res, method, pathname, ctx = {}) {
  // 已独立迁 Go 的子路由：保留委托顺序，不在此文件重复处理。
  if (await handleWebUiToolAppSettingsRoutes(req, res, method, pathname, ctx)) return true;
  if (await handleWebUiProviderConfigRoutes(req, res, method, pathname, ctx)) return true;
  if (await handleWebUiEdgeProxyRoutes(req, res, method, pathname, ctx)) return true;
  if (await handleWebUiSubscriptionAggregatorRoutes(req, res, method, pathname, ctx)) return true;

  if (pathname.startsWith('/v0/webui/toolkit/tools/') && pathname.includes('/service')) {
    if (await handleWebUiToolServiceRoutes(req, res, method, pathname, ctx)) return true;
  }
  if (pathname === '/v0/webui/toolkit/tools' || pathname.startsWith('/v0/webui/toolkit/tools/')) {
    if (await handleWebUiManagedToolRoutes(req, res, method, pathname, ctx)) return true;
  }

  const routeCtx = buildRouteCtx(ctx, req, res, method, pathname);

  const configAppId = resolveSegmentId(pathname, '/v0/webui/toolkit/apps/', '/config');
  if (configAppId === null) {
    routeCtx.writeJson(routeCtx.res, 400, { ok: false, error: 'invalid_app_path', message: '应用路径无效' });
    return true;
  }
  if (configAppId && (method === 'GET' || method === 'PUT')) {
    let body;
    if (method === 'PUT') {
      body = await readJsonBody(routeCtx, {
        maxBytes: CONFIG_BODY_MAX_BYTES,
        invalidCode: 'invalid_request_body',
        invalidMessage: '配置请求参数无效'
      });
      if (body === null) return true;
    }
    return proxyWebuiGo(routeCtx, {
      method,
      path: `/v1/management/webui/toolkit/apps/${encodeURIComponent(configAppId)}/config`,
      body,
      passStatuses: TOOLKIT_PASS_STATUSES,
      message: 'Go Core 未就绪，无法访问应用配置文件'
    });
  }

  const configToolId = resolveSegmentId(pathname, '/v0/webui/toolkit/tools/', '/config');
  if (configToolId === null) {
    routeCtx.writeJson(routeCtx.res, 400, { ok: false, error: 'invalid_tool_path', message: '工具路径无效' });
    return true;
  }
  if (configToolId && (method === 'GET' || method === 'PUT')) {
    let body;
    if (method === 'PUT') {
      body = await readJsonBody(routeCtx, {
        maxBytes: CONFIG_BODY_MAX_BYTES,
        invalidCode: 'invalid_request_body',
        invalidMessage: '配置请求参数无效'
      });
      if (body === null) return true;
    }
    return proxyWebuiGo(routeCtx, {
      method,
      path: `/v1/management/webui/toolkit/tools/${encodeURIComponent(configToolId)}/config`,
      body,
      passStatuses: TOOLKIT_PASS_STATUSES,
      message: 'Go Core 未就绪，无法访问工具配置文件'
    });
  }

  if (method === 'GET' && pathname === '/v0/webui/toolkit/tools') {
    return proxyWebuiGo(routeCtx, {
      method: 'GET',
      path: '/v1/management/webui/toolkit/tools',
      passStatuses: TOOLKIT_PASS_STATUSES,
      message: 'Go Core 未就绪，无法读取受管工具列表'
    });
  }

  if (method === 'GET' && pathname === '/v0/webui/toolkit/apps') {
    return proxyWebuiGo(routeCtx, {
      method: 'GET',
      path: '/v1/management/webui/toolkit/apps',
      query: readQueryString(routeCtx, req),
      passStatuses: TOOLKIT_PASS_STATUSES,
      message: 'Go Core 未就绪，无法读取受管应用列表'
    });
  }

  const checkUpdateMatch = pathname.match(/^\/v0\/webui\/toolkit\/apps\/([^/]+)\/check-update$/);
  if (method === 'POST' && checkUpdateMatch) {
    const appId = decodeMatchSegment(checkUpdateMatch[1], 'invalid_app_path');
    if (typeof appId !== 'string') {
      routeCtx.writeJson(routeCtx.res, 400, { ok: false, error: appId.invalidError });
      return true;
    }
    return proxyWebuiGo(routeCtx, {
      method: 'POST',
      path: `/v1/management/webui/toolkit/apps/${encodeURIComponent(appId)}/check-update`,
      passStatuses: TOOLKIT_PASS_STATUSES,
      message: 'Go Core 未就绪，无法检查应用更新'
    });
  }

  const openAppMatch = pathname.match(/^\/v0\/webui\/toolkit\/apps\/([^/]+)\/open$/);
  if (method === 'POST' && openAppMatch) {
    const appId = decodeMatchSegment(openAppMatch[1], 'invalid_app_path');
    if (typeof appId !== 'string') {
      routeCtx.writeJson(routeCtx.res, 400, { ok: false, error: appId.invalidError });
      return true;
    }
    const body = await readJsonBody(routeCtx, {
      invalidCode: 'invalid_request_body',
      invalidMessage: '启动参数无效'
    });
    if (body === null) return true;

    const deps = routeCtx.deps || {};
    const kind = String(body.kind || (appId.endsWith('-desktop') ? 'desktop' : 'cli')).trim().toLowerCase();
    const provider = kind === 'desktop' && appId.endsWith('-desktop')
      ? appId.slice(0, -'-desktop'.length)
      : String(body.provider || appId).trim().toLowerCase();
    const proxyBody = { ...body };
    if (kind === 'cli') {
      const transport = resolveTerminalTransport({
        req: routeCtx.req,
        requested: body.transport,
        processObj: routeCtx.processObj || deps.processObj || process,
        env: routeCtx.env || deps.env
      });
      proxyBody.transport = transport;
      if (transport === 'webui' && !String(body.sessionKey || '').trim()) {
        proxyBody.sessionKey = defaultWebTerminalSessionKey({
          accountRef: String(body.accountRef || '').trim(),
          harness: provider
        });
      }
    }
    return proxyWebuiGo(routeCtx, {
      method: 'POST',
      path: `/v1/management/webui/toolkit/apps/${encodeURIComponent(appId)}/open`,
      body: proxyBody,
      passStatuses: TOOLKIT_PASS_STATUSES,
      message: 'Go Core 未就绪，无法打开受管应用'
    });
  }

  if (method === 'POST' && pathname === '/v0/webui/toolkit/apps/install') {
    const body = await readJsonBody(routeCtx);
    if (body === null) return true;
    return proxyWebuiGo(routeCtx, {
      method: 'POST',
      path: '/v1/management/webui/toolkit/apps/install',
      body,
      status: 202,
      passStatuses: TOOLKIT_PASS_STATUSES,
      message: 'Go Core 未就绪，无法创建应用安装任务'
    });
  }

  if (method === 'POST' && pathname === '/v0/webui/toolkit/apps/plan') {
    const body = await readJsonBody(routeCtx);
    if (body === null) return true;
    return proxyWebuiGo(routeCtx, {
      method: 'POST',
      path: '/v1/management/webui/toolkit/apps/plan',
      body,
      passStatuses: TOOLKIT_PASS_STATUSES,
      message: 'Go Core 未就绪，无法生成应用安装计划'
    });
  }

  if (method === 'POST' && pathname === '/v0/webui/toolkit/apps/hooks') {
    const body = await readJsonBody(routeCtx);
    if (body === null) return true;
    return proxyWebuiGo(routeCtx, {
      method: 'POST',
      path: '/v1/management/webui/toolkit/apps/hooks',
      body,
      passStatuses: TOOLKIT_PASS_STATUSES,
      message: 'Go Core 未就绪，无法管理应用 Hook'
    });
  }

  if (method === 'GET' && pathname === '/v0/webui/toolkit/mirrors') {
    return proxyWebuiGo(routeCtx, {
      method: 'GET',
      path: '/v1/management/webui/toolkit/mirrors',
      query: readQueryString(routeCtx, req),
      passStatuses: TOOLKIT_PASS_STATUSES,
      message: 'Go Core 未就绪，无法读取镜像状态'
    });
  }

  if (method === 'POST' && pathname === '/v0/webui/toolkit/mirrors/set') {
    const body = await readJsonBody(routeCtx);
    if (body === null) return true;
    return proxyWebuiGo(routeCtx, {
      method: 'POST',
      path: '/v1/management/webui/toolkit/mirrors/set',
      body,
      passStatuses: TOOLKIT_PASS_STATUSES,
      message: 'Go Core 未就绪，无法设置镜像源'
    });
  }

  if (method === 'POST' && pathname === '/v0/webui/toolkit/mirrors/ping') {
    const body = await readJsonBody(routeCtx);
    if (body === null) return true;
    return proxyWebuiGo(routeCtx, {
      method: 'POST',
      path: '/v1/management/webui/toolkit/mirrors/ping',
      body,
      passStatuses: TOOLKIT_PASS_STATUSES,
      message: 'Go Core 未就绪，无法探测镜像延迟'
    });
  }

  if (method === 'GET' && pathname === '/v0/webui/toolkit/proxy') {
    return proxyWebuiGo(routeCtx, {
      method: 'GET',
      path: '/v1/management/webui/toolkit/proxy',
      query: readQueryString(routeCtx, req),
      passStatuses: TOOLKIT_PASS_STATUSES,
      message: 'Go Core 未就绪，无法读取代理状态'
    });
  }

  if (method === 'POST' && pathname === '/v0/webui/toolkit/proxy/set') {
    const body = await readJsonBody(routeCtx);
    if (body === null) return true;
    return proxyWebuiGo(routeCtx, {
      method: 'POST',
      path: '/v1/management/webui/toolkit/proxy/set',
      body,
      passStatuses: TOOLKIT_PASS_STATUSES,
      message: 'Go Core 未就绪，无法设置工具代理'
    });
  }

  if (method === 'GET' && pathname === '/v0/webui/toolkit/connectivity') {
    return proxyWebuiGo(routeCtx, {
      method: 'GET',
      path: '/v1/management/webui/toolkit/connectivity',
      query: readQueryString(routeCtx, req),
      passStatuses: TOOLKIT_PASS_STATUSES,
      message: 'Go Core 未就绪，无法探测上游连通性'
    });
  }

  return false;
}

module.exports = {
  handleWebUiToolkitRoutes
};
