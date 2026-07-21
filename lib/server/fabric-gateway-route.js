'use strict';

const { SUPPORTED_SERVER_PROVIDERS } = require('./providers');

function readGatewayRequestProvider(headers = {}, requestJson = {}) {
  const provider = String(
    headers['x-provider']
    || headers['X-Provider']
    || requestJson.provider
    || ''
  ).trim().toLowerCase();
  return SUPPORTED_SERVER_PROVIDERS.includes(provider) ? provider : '';
}

function recordFabricGatewayResult(input, gatewayResult, deps = {}) {
  const routeKey = `${input.method} ${input.pathname}`;
  if (typeof deps.incrementRouteMetrics === 'function') {
    deps.incrementRouteMetrics(input.state, routeKey);
  }
  const metrics = input.state && input.state.metrics;
  if (!metrics) return;
  const statusCode = Number(input.res.statusCode || 0);
  if (gatewayResult.reason === 'proxied' && statusCode >= 200 && statusCode < 400) {
    metrics.totalSuccess = Number(metrics.totalSuccess || 0) + 1;
    return;
  }
  metrics.totalFailures = Number(metrics.totalFailures || 0) + 1;
  if (typeof deps.pushMetricError !== 'function') return;
  deps.pushMetricError(metrics, routeKey, 'fabric-gateway', {
    statusCode,
    serverId: String(gatewayResult.serverId || ''),
    reason: String(gatewayResult.reason || '')
  });
}

async function tryFabricGatewayRoute(input = {}, deps = {}) {
  if (typeof deps.proxyFabricGatewayRequest !== 'function') return false;
  const gatewayResult = await deps.proxyFabricGatewayRequest({
    req: input.req,
    res: input.res,
    method: input.method,
    pathname: input.pathname,
    options: input.options,
    state: input.state,
    bodyBuffer: input.bodyBuffer,
    provider: readGatewayRequestProvider(input.req && input.req.headers, input.requestJson),
    model: input.model
  }, {
    writeJson: deps.writeJson,
    fabricBrokerSessionRegistry: deps.fabricBrokerSessionRegistry
  });
  if (!gatewayResult || !gatewayResult.handled) return false;
  recordFabricGatewayResult(input, gatewayResult, deps);
  return true;
}

module.exports = {
  readGatewayRequestProvider,
  recordFabricGatewayResult,
  tryFabricGatewayRoute
};
