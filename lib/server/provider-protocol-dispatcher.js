'use strict';

const {
  createProviderProtocolRouteDeps,
  createProviderProtocolRouteMeta
} = require('./provider-protocol-routing');
const {
  mergeProviderProtocolPlanIntoRequestMeta
} = require('./provider-protocol-plan');

function withProviderProtocolRouteMeta(requestMeta, route) {
  const routeMeta = createProviderProtocolRouteMeta(route);
  if (!routeMeta) return requestMeta || {};
  const sourceClientProtocol = String(
    requestMeta && requestMeta.sourceClientProtocol
    || requestMeta && requestMeta.clientProtocol
    || routeMeta.clientProtocol
    || ''
  ).trim();
  return mergeProviderProtocolPlanIntoRequestMeta({
    ...(requestMeta || {}),
    ...(routeMeta.clientProtocol && !(requestMeta && requestMeta.clientProtocol)
      ? { clientProtocol: routeMeta.clientProtocol }
      : {}),
    ...(sourceClientProtocol ? { sourceClientProtocol } : {}),
    providerProtocolRoute: routeMeta
  }, { route: routeMeta, sourceClientProtocol });
}

async function dispatchProviderProtocolRoute(ctx) {
  if (!ctx || !ctx.route || typeof ctx.handleUpstreamPassthrough !== 'function') return false;
  const routeDeps = createProviderProtocolRouteDeps(ctx.route, ctx.deps);
  if (!routeDeps) return false;
  const result = await ctx.handleUpstreamPassthrough({
    options: ctx.options,
    state: ctx.state,
    req: ctx.req,
    res: ctx.res,
    method: ctx.method,
    bodyBuffer: ctx.bodyBuffer,
    routeKey: ctx.routeKey,
    requestStartedAt: ctx.requestStartedAt,
    cooldownMs: ctx.cooldownMs,
    requestJson: ctx.requestJson,
    requestMeta: withProviderProtocolRouteMeta(ctx.requestMeta, ctx.route),
    deps: routeDeps
  });
  return result || true;
}

module.exports = {
  dispatchProviderProtocolRoute,
  __private: {
    withProviderProtocolRouteMeta
  }
};
