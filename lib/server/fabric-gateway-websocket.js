'use strict';

const { acquireFabricGatewaySlot } = require('./fabric-gateway-capacity');
const { selectFabricGatewayServer } = require('./fabric-gateway-capability');
const { hasLocalProviderAccounts } = require('./fabric-gateway-fallback');
const {
  MAX_FABRIC_GATEWAY_HOPS,
  normalizeGatewayHop
} = require('./fabric-gateway-protocol');
const {
  DEFAULT_FABRIC_GATEWAY_WEBSOCKET_OPEN_TIMEOUT_MS,
  createFabricGatewayWebSocketSession
} = require('./fabric-gateway-websocket-session');

function writeUpgradeError(socket, statusCode, error, headers = {}) {
  if (!socket || socket.destroyed) return;
  const statusText = {
    429: 'Too Many Requests',
    502: 'Bad Gateway',
    503: 'Service Unavailable',
    504: 'Gateway Timeout'
  }[statusCode] || 'Bad Gateway';
  const body = JSON.stringify({ ok: false, error });
  const extraHeaders = Object.entries(headers)
    .map(([name, value]) => `${name}: ${value}\r\n`)
    .join('');
  socket.write(
    `HTTP/1.1 ${statusCode} ${statusText}\r\n`
      + 'content-type: application/json\r\n'
      + `content-length: ${Buffer.byteLength(body)}\r\n`
      + extraHeaders
      + 'connection: close\r\n\r\n'
      + body
  );
  socket.destroy();
}

function gatewayWebSocketPath(req) {
  try {
    const url = new URL(String(req && req.url || '/v1/responses'), 'http://gateway.local');
    return `${url.pathname}${url.search}`;
  } catch (_error) {
    return '/v1/responses';
  }
}

async function proxyFabricGatewayWebSocket(input = {}, deps = {}) {
  if (hasLocalProviderAccounts(input.state)) return false;
  const currentHop = normalizeGatewayHop(input.req?.headers?.['x-aih-gateway-hop']);
  if (currentHop >= MAX_FABRIC_GATEWAY_HOPS) return false;
  const registry = deps.fabricBrokerSessionRegistry;
  const servers = registry && typeof registry.listBrokerServers === 'function'
    ? registry.listBrokerServers()
    : [];
  const server = selectFabricGatewayServer(servers, '', 'codex');
  if (!server) return false;
  const session = registry.getBrokerSession(server.stableServerId);
  const controlSocket = session && session.socket;
  if (!controlSocket || controlSocket.readyState !== 1) return false;

  const releaseSlot = acquireFabricGatewaySlot(
    server.stableServerId,
    deps.fabricGatewayMaxConcurrentRequests
  );
  if (!releaseSlot) {
    writeUpgradeError(input.socket, 429, 'fabric_gateway_concurrency_limited', { 'retry-after': '1' });
    return true;
  }

  const gatewaySession = createFabricGatewayWebSocketSession({
    req: input.req,
    socket: input.socket,
    head: input.head,
    requestId: input.requestId,
    pathname: gatewayWebSocketPath(input.req)
  }, {
    WebSocket: deps.WebSocket,
    controlSocket,
    gatewayHop: currentHop + 1,
    openTimeoutMs: deps.fabricGatewayWebSocketOpenTimeoutMs,
    releaseSlot
  });
  try {
    await gatewaySession.open();
    return true;
  } catch (error) {
    const timeout = error && error.code === 'fabric_gateway_websocket_open_timeout';
    writeUpgradeError(
      input.socket,
      timeout ? 504 : 502,
      timeout ? 'fabric_gateway_websocket_open_timeout' : 'fabric_gateway_websocket_open_failed'
    );
    return true;
  }
}

module.exports = {
  DEFAULT_FABRIC_GATEWAY_WEBSOCKET_OPEN_TIMEOUT_MS,
  gatewayWebSocketPath,
  proxyFabricGatewayWebSocket
};
