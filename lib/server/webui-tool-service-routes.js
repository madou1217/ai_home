'use strict';

const toolServiceManager = require('../cli/services/toolkit/tool-service-manager');
const { buildManagedToolOptions, readJsonBody } = require('./webui-managed-tool-routes');

const SERVICE_PATH = /^\/v0\/webui\/toolkit\/tools\/([^/]+)\/service(?:\/(settings|config|logs))?$/;

function parseServicePath(pathname) {
  const match = String(pathname || '').match(SERVICE_PATH);
  if (!match) return null;
  try {
    return { toolId: decodeURIComponent(match[1]), sub: match[2] || '' };
  } catch (_error) {
    return { invalid: true };
  }
}

function statusFor(result) {
  if (result && result.ok) return 200;
  const error = String(result && result.error || '');
  if (error === 'confirmation_required') return 428;
  if (error === 'managed_tool_not_found') return 404;
  if (error === 'service_conflict_external_instance' || error === 'service_config_exists'
    || error === 'service_config_missing' || error === 'managed_tool_not_installed'
    || error === 'service_settings_readonly') return 409;
  if (error === 'service_control_failed' || error === 'service_spawn_failed') return 502;
  if (error.startsWith('unsupported_') || error.startsWith('invalid_') || error === 'service_unsupported'
    || error === 'service_config_create_unsupported') return 400;
  return 500;
}

function writeResult(ctx, result) {
  const status = statusFor(result);
  if (typeof ctx.writeJson === 'function') ctx.writeJson(ctx.res, status, result);
  else {
    ctx.res.writeHead(status, { 'Content-Type': 'application/json' });
    ctx.res.end(JSON.stringify(result));
  }
}

/**
 * 托管工具服务控制路由：
 *   GET  /v0/webui/toolkit/tools/:id/service            状态
 *   POST /v0/webui/toolkit/tools/:id/service            { action: start|stop|restart, confirmed: true }
 *   PUT  /v0/webui/toolkit/tools/:id/service/settings   { autoStart?, autoRestart? }
 *   POST /v0/webui/toolkit/tools/:id/service/config     新建默认配置
 *   GET  /v0/webui/toolkit/tools/:id/service/logs       最近日志
 */
async function handleWebUiToolServiceRoutes(req, res, method, pathname, ctx = {}) {
  const parsed = parseServicePath(pathname);
  if (!parsed) return false;
  const routeCtx = { ...ctx, req, res, method, pathname };
  if (parsed.invalid) {
    writeResult(routeCtx, { ok: false, error: 'invalid_service_path', message: '服务路径无效。' });
    return true;
  }
  const manager = (ctx.deps && ctx.deps.toolServiceManager) || toolServiceManager;
  const options = buildManagedToolOptions(ctx);
  const { toolId, sub } = parsed;

  if (!sub && method === 'GET') {
    writeResult(routeCtx, manager.getManagedToolService(toolId, options));
    return true;
  }
  if (!sub && method === 'POST') {
    const body = await readJsonBody(routeCtx);
    if (!body) {
      writeResult(routeCtx, { ok: false, error: 'invalid_service_payload', message: '服务操作参数无效。' });
    } else if (body.confirmed !== true) {
      writeResult(routeCtx, { ok: false, error: 'confirmation_required', message: '服务操作需要确认。' });
    } else {
      writeResult(routeCtx, await manager.controlManagedToolService(toolId, body.action, options));
    }
    return true;
  }
  if (sub === 'settings' && method === 'PUT') {
    const body = await readJsonBody(routeCtx);
    writeResult(routeCtx, body
      ? manager.updateManagedToolServiceSettings(toolId, {
        autoStart: typeof body.autoStart === 'boolean' ? body.autoStart : undefined,
        autoRestart: typeof body.autoRestart === 'boolean' ? body.autoRestart : undefined
      }, options)
      : { ok: false, error: 'invalid_service_payload', message: '服务设置参数无效。' });
    return true;
  }
  if (sub === 'config' && method === 'POST') {
    writeResult(routeCtx, manager.createManagedToolServiceConfig(toolId, options));
    return true;
  }
  if (sub === 'logs' && method === 'GET') {
    const url = ctx.url instanceof URL ? ctx.url : null;
    const lines = Number(url && url.searchParams.get('lines')) || 200;
    writeResult(routeCtx, manager.readManagedToolServiceLogs(toolId, { ...options, lines }));
    return true;
  }
  writeResult(routeCtx, { ok: false, error: 'unsupported_service_route', message: '不支持的服务操作。' });
  return true;
}

module.exports = {
  handleWebUiToolServiceRoutes,
  parseServicePath
};
