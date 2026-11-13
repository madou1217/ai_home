'use strict';

// WebUI 数据面：账号出口设置路由薄代理 —— 全部校验、绑定落盘、出口池拉起、
// 车道重排、数据面连通性探测与失败回滚均已迁移至 Go Core（零 Node 回落）。
//
//   GET  /v0/webui/accounts/:provider/:accountRef/egress
//       -> GET  /v1/management/webui/accounts/:provider/:accountRef/egress
//   POST /v0/webui/accounts/:provider/:accountRef/egress
//       -> POST /v1/management/webui/accounts/:provider/:accountRef/egress

const { proxyWebuiGo } = require('./webui-go-proxy');

const EGRESS_ROUTE_PATTERN = /^\/v0\/webui\/accounts\/([^/]+)\/([^/]+)\/egress$/;
const GO_ACCOUNTS_PREFIX = '/v1/management/webui/accounts';

function parseEgressRoute(pathname) {
  const match = EGRESS_ROUTE_PATTERN.exec(String(pathname || ''));
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

function matchEgressRoute(method, pathname) {
  const verb = String(method || '').toUpperCase();
  return EGRESS_ROUTE_PATTERN.test(String(pathname || '')) && (verb === 'GET' || verb === 'POST');
}

function invalidateEgressIndex(ctx) {
  const index = ctx && ctx.state && ctx.state.accountEgressBindingIndex;
  if (index && typeof index.invalidate === 'function') index.invalidate();
}

async function handleZcodeEgressRequest(ctx) {
  const { pathname, writeJson } = ctx;
  const parsed = parseEgressRoute(pathname);
  if (!parsed || !parsed.provider || !parsed.accountRef) {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_account_path' });
    return true;
  }

  const method = String((ctx.req && ctx.req.method) || '').toUpperCase();
  const goPath = `${GO_ACCOUNTS_PREFIX}/${encodeURIComponent(parsed.provider)}/${encodeURIComponent(parsed.accountRef)}/egress`;

  if (method === 'GET') {
    return proxyWebuiGo(ctx, {
      method: 'GET',
      path: goPath,
      passStatuses: [400, 404, 409, 500],
      message: 'Go Core 未就绪，账号出口不可读'
    });
  }

  let payload;
  try {
    const body = await ctx.readRequestBody(ctx.req, { maxBytes: 16 * 1024 });
    payload = body ? JSON.parse(body.toString('utf8')) : {};
  } catch {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_json_body' });
    return true;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_request_body' });
    return true;
  }

  return proxyWebuiGo(ctx, {
    method: 'POST',
    path: goPath,
    body: payload,
    passStatuses: [400, 404, 409, 500],
    message: 'Go Core 未就绪，账号出口设置未保存',
    transform: (data) => {
      invalidateEgressIndex(ctx);
      return data;
    }
  });
}

module.exports = {
  EGRESS_ROUTE_PATTERN,
  handleZcodeEgressRequest,
  matchEgressRoute,
  parseEgressRoute
};
