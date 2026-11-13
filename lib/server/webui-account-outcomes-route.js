'use strict';

// GET /v0/webui/account-outcomes：账号页状态条（90 天按天 + 最近 24 小时按小时）。
// 聚合计算全部在 Go（webuiaccountoutcomesapi），Node 只做薄代理，绝不本地回退。

const { proxyWebuiGo } = require('./webui-go-proxy');

async function handleWebUiAccountOutcomesRoute(ctx = {}) {
  const { method, pathname } = ctx;
  if (method !== 'GET' || pathname !== '/v0/webui/account-outcomes') return false;
  const routeCtx = typeof ctx.writeJson === 'function'
    ? ctx
    : {
        ...ctx,
        writeJson: (res, status, payload) => {
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(payload));
        }
      };
  return proxyWebuiGo(routeCtx, {
    method: 'GET',
    path: '/v1/management/webui/account-outcomes',
    passStatuses: [400, 404, 409, 503],
    message: 'Go Core 未就绪，账号结果不可用'
  });
}

module.exports = { handleWebUiAccountOutcomesRoute };
