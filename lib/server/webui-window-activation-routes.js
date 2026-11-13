'use strict';

// WebUI 账号「窗口激活」设置与状态路由（Provider 能力闸门、minIntervalMs 下限、app_kv 持久化与全局调度态均已迁 Go）：
//   GET  /v0/webui/accounts/:provider/:accountRef/window-activation -> GET  /v1/management/webui/accounts/:provider/:accountRef/window-activation
//   POST /v0/webui/accounts/:provider/:accountRef/window-activation -> POST /v1/management/webui/accounts/:provider/:accountRef/window-activation

const { proxyWebuiGo } = require('./webui-go-proxy');

const WINDOW_ACTIVATION_ROUTE_PATTERN = /^\/v0\/webui\/accounts\/([^/]+)\/([^/]+)\/window-activation$/;
const GO_ACCOUNTS_PREFIX = '/v1/management/webui/accounts';

function writeJson(ctx, status, payload) {
  if (typeof ctx.writeJson === 'function') {
    ctx.writeJson(ctx.res, status, payload);
    return;
  }
  ctx.res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  ctx.res.end(JSON.stringify(payload));
}

function parseWindowActivationRoute(pathname) {
  const match = WINDOW_ACTIVATION_ROUTE_PATTERN.exec(String(pathname || ''));
  if (!match) return null;
  try {
    return {
      provider: decodeURIComponent(match[1]).trim().toLowerCase(),
      accountRef: decodeURIComponent(match[2]).trim()
    };
  } catch {
    return null;
  }
}

function matchWindowActivationRoute(method, pathname) {
  const verb = String(method || '').toUpperCase();
  return WINDOW_ACTIVATION_ROUTE_PATTERN.test(String(pathname || '')) && (verb === 'GET' || verb === 'POST');
}

async function handleWindowActivationRequest(ctx = {}) {
  const pathname = String(ctx.pathname || '');
  const parsed = parseWindowActivationRoute(pathname);
  if (!parsed || !parsed.provider || !parsed.accountRef) {
    writeJson(ctx, 400, { ok: false, error: 'invalid_account_path' });
    return true;
  }
  const method = String(ctx.method || (ctx.req && ctx.req.method) || '').toUpperCase();
  if (method !== 'GET' && method !== 'POST') {
    writeJson(ctx, 405, { ok: false, error: 'method_not_allowed' });
    return true;
  }
  const goPath = `${GO_ACCOUNTS_PREFIX}/${encodeURIComponent(parsed.provider)}/${encodeURIComponent(parsed.accountRef)}/window-activation`;
  if (method === 'GET') {
    return proxyWebuiGo(ctx, {
      method: 'GET',
      path: goPath,
      message: 'Go Core 未就绪，窗口激活不可读'
    });
  }

  let payload;
  try {
    const body = typeof ctx.readRequestBody === 'function'
      ? await ctx.readRequestBody(ctx.req, { maxBytes: 16 * 1024 })
      : null;
    payload = body ? JSON.parse(body.toString('utf8')) : {};
  } catch {
    writeJson(ctx, 400, { ok: false, error: 'invalid_json_body' });
    return true;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    writeJson(ctx, 400, { ok: false, error: 'invalid_request_body' });
    return true;
  }

  return proxyWebuiGo(ctx, {
    method: 'POST',
    path: goPath,
    body: payload,
    message: 'Go Core 未就绪，窗口激活设置不可写'
  });
}

module.exports = {
  WINDOW_ACTIVATION_ROUTE_PATTERN,
  handleWindowActivationRequest,
  matchWindowActivationRoute,
  parseWindowActivationRoute
};
