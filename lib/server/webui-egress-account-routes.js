'use strict';

// 账号级出口池运行时与分配路由 —— 全部校验、持久化和车道重排已迁移至 Go Core（零 Node 回落）。
//   GET /v0/webui/accounts/:provider/:accountRef/egress-runtime
//       -> GET /v1/management/webui/egress/accounts/:provider/:accountRef/egress-runtime
//   PUT /v0/webui/accounts/:provider/:accountRef/egress-assignment
//       -> PUT /v1/management/webui/egress/accounts/:provider/:accountRef/egress-assignment

const { proxyWebuiGo } = require('./webui-go-proxy');

const ASSIGNMENT_ROUTE = /^\/v0\/webui\/accounts\/([^/]+)\/([^/]+)\/egress-assignment$/;
const RUNTIME_ROUTE = /^\/v0\/webui\/accounts\/([^/]+)\/([^/]+)\/egress-runtime$/;
const GO_PREFIX = '/v1/management/webui/egress/accounts';

function parse(pattern, pathname) {
  const match = pattern.exec(String(pathname || ''));
  if (!match) return null;
  try {
    return {
      provider: decodeURIComponent(match[1]).trim().toLowerCase(),
      accountRef: decodeURIComponent(match[2]).trim()
    };
  } catch (_error) {
    return null;
  }
}

function matchAccountEgressRoute(method, pathname) {
  const verb = String(method || '').toUpperCase();
  const path = String(pathname || '');
  return (verb === 'GET' && RUNTIME_ROUTE.test(path))
    || (verb === 'PUT' && ASSIGNMENT_ROUTE.test(path));
}

async function readJsonBody(ctx) {
  try {
    const raw = typeof ctx.readRequestBody === 'function'
      ? await ctx.readRequestBody(ctx.req, { maxBytes: 32 * 1024 })
      : null;
    const value = raw && raw.length ? JSON.parse(raw.toString('utf8')) : null;
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch (_error) {
    return null;
  }
}

async function handleWebUiEgressAccountRequest(ctx = {}) {
  const { writeJson, req, res } = ctx;
  const method = String(ctx.method || (req && req.method) || '').toUpperCase();
  const pathname = String(ctx.pathname || '');
  const parsed = method === 'PUT' ? parse(ASSIGNMENT_ROUTE, pathname) : parse(RUNTIME_ROUTE, pathname);
  if (!parsed || !parsed.provider || !parsed.accountRef) {
    writeJson(res, 400, { ok: false, error: 'invalid_account_path' });
    return true;
  }

  const encodedProvider = encodeURIComponent(parsed.provider);
  const encodedRef = encodeURIComponent(parsed.accountRef);

  if (method === 'GET') {
    return proxyWebuiGo(ctx, {
      method: 'GET',
      path: `${GO_PREFIX}/${encodedProvider}/${encodedRef}/egress-runtime`,
      message: 'Go Core 未就绪，无法读取账号出口池运行时'
    });
  }

  const body = await readJsonBody(ctx);
  if (!body) {
    writeJson(res, 400, { ok: false, error: 'invalid_json_body' });
    return true;
  }
  return proxyWebuiGo(ctx, {
    method: 'PUT',
    path: `${GO_PREFIX}/${encodedProvider}/${encodedRef}/egress-assignment`,
    body,
    message: 'Go Core 未就绪，无法保存账号出口池配置'
  });
}

module.exports = {
  handleWebUiEgressAccountRequest,
  matchAccountEgressRoute
};
