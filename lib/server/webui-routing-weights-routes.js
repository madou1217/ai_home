'use strict';

// GET /v0/webui/routing/weights：Provider × 模型选号权重与下次命中概率诊断。
//
// 账号池、模型目录收窄、运行态资格、额度门禁与并发负载已全部迁移至 Go
// （webuiroutingweightsapi）；Node 只保留零回退薄代理，Go 不可用时显式回 503。

const { proxyWebuiGo } = require('./webui-go-proxy');

const ROUTING_WEIGHTS_ROUTE = '/v0/webui/routing/weights';
const GO_ROUTING_WEIGHTS_PATH = '/v1/management/webui/routing/weights';

function buildForwardedQuery(ctx) {
  let search = '';
  if (ctx && ctx.url && typeof ctx.url.search === 'string') {
    search = ctx.url.search;
  } else {
    const raw = typeof (ctx && ctx.url) === 'string'
      ? ctx.url
      : String((ctx && ctx.req && ctx.req.url) || '');
    const idx = raw.indexOf('?');
    if (idx >= 0) search = raw.slice(idx);
  }
  const source = new URLSearchParams(search.replace(/^\?/, ''));
  const forwarded = new URLSearchParams();
  if (source.has('provider')) forwarded.set('provider', source.get('provider'));
  if (source.has('model')) forwarded.set('model', source.get('model'));
  return forwarded.toString();
}

function withWriteJson(ctx) {
  if (ctx && typeof ctx.writeJson === 'function') return ctx;
  return {
    ...ctx,
    writeJson: (res, status, payload) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    }
  };
}

async function handleWebUiRoutingWeightsRoutes(ctx = {}) {
  const { method, pathname } = ctx;
  if (method !== 'GET' || pathname !== ROUTING_WEIGHTS_ROUTE) {
    return false;
  }
  return proxyWebuiGo(withWriteJson(ctx), {
    method: 'GET',
    path: GO_ROUTING_WEIGHTS_PATH,
    query: buildForwardedQuery(ctx),
    passStatuses: [400, 404],
    message: 'Go Core 未就绪，无法读取路由权重'
  });
}

module.exports = { handleWebUiRoutingWeightsRoutes };
