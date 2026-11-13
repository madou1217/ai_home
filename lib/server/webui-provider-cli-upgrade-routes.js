'use strict';

// provider CLI 自动升级状态面与解除熔断路由（全部业务与调度态均由 Go Core 提供，零 Node 回落）：
//   GET  /v0/webui/provider-cli-upgrade                    -> GET  /v1/management/webui/provider-cli-upgrade
//   POST /v0/webui/provider-cli-upgrade/:provider/clear-broken -> POST /v1/management/webui/provider-cli-upgrade/:provider/clear-broken

const { callGoHost, proxyWebuiGo, writeGoFailure } = require('./webui-go-proxy');

const ROUTE_PATH = '/v0/webui/provider-cli-upgrade';
const GO_BASE_PATH = '/v1/management/webui/provider-cli-upgrade';
const CLEAR_BROKEN_PATTERN = /^\/v0\/webui\/provider-cli-upgrade\/([a-z0-9_-]+)\/clear-broken$/;

const GO_UNAVAILABLE_MESSAGE = 'Go Core 未就绪，升级状态不可读';
const GO_CLEAR_BROKEN_UNAVAILABLE_MESSAGE = 'Go Core 未就绪，无法解除升级熔断';

function writeJson(ctx, status, payload) {
  if (typeof ctx.writeJson === 'function') {
    ctx.writeJson(ctx.res, status, payload);
    return;
  }
  ctx.res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  ctx.res.end(JSON.stringify(payload));
}

async function handleClearBrokenRoute(ctx, provider, method) {
  if (method !== 'POST') {
    writeJson(ctx, 405, { ok: false, error: 'method_not_allowed' });
    return true;
  }
  const { available, response } = await callGoHost(ctx, 'webuiRequest', [{
    method: 'POST',
    path: `${GO_BASE_PATH}/${encodeURIComponent(provider)}/clear-broken`
  }]);
  if (!available) {
    writeJson(ctx, 503, {
      ok: false,
      error: 'go_core_unavailable',
      message: GO_CLEAR_BROKEN_UNAVAILABLE_MESSAGE
    });
    return true;
  }
  const data = response && response.data;
  if (!data || typeof data !== 'object') {
    return writeGoFailure(ctx, response, {
      message: GO_CLEAR_BROKEN_UNAVAILABLE_MESSAGE
    });
  }
  if (response.ok === true) {
    writeJson(ctx, Number(response.status) || 200, data);
    return true;
  }
  // Go 把「非法/未知 provider」回 400；WebUI 契约把它当业务结论回 422，前端只认 409/422。
  const goStatus = Number(response.status) || 0;
  if (goStatus === 400) {
    writeJson(ctx, 422, data);
    return true;
  }
  const passStatuses = data.reason ? [404, 409, 422, 500] : [404, 409, 422];
  return writeGoFailure(ctx, response, {
    passStatuses,
    message: GO_CLEAR_BROKEN_UNAVAILABLE_MESSAGE
  });
}

async function handleProviderCliUpgradeRoutes(ctx = {}) {
  const pathname = String(ctx.pathname || '');
  const method = String(ctx.method || (ctx.req && ctx.req.method) || '').toUpperCase();
  const clearMatch = pathname.match(CLEAR_BROKEN_PATTERN);
  if (clearMatch) {
    return handleClearBrokenRoute(ctx, clearMatch[1], method);
  }
  if (pathname !== ROUTE_PATH) {
    return false;
  }
  if (method !== 'GET') {
    writeJson(ctx, 405, { ok: false, error: 'method_not_allowed' });
    return true;
  }
  return proxyWebuiGo(ctx, {
    method: 'GET',
    path: GO_BASE_PATH,
    message: GO_UNAVAILABLE_MESSAGE
  });
}

module.exports = {
  ROUTE_PATH,
  handleProviderCliUpgradeRoutes
};
