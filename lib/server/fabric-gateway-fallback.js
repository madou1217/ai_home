'use strict';

const crypto = require('node:crypto');
const {
  DEFAULT_FABRIC_GATEWAY_CONCURRENCY,
  acquireFabricGatewaySlot
} = require('./fabric-gateway-capacity');
const { selectFabricGatewayServer } = require('./fabric-gateway-capability');
const { SUPPORTED_SERVER_PROVIDERS } = require('./providers');
const {
  FABRIC_GATEWAY_PROTOCOL_VERSION,
  FABRIC_GATEWAY_REQUEST_PURPOSE,
  MAX_FABRIC_GATEWAY_HOPS,
  normalizeGatewayHop,
  pickFabricGatewayHeaders
} = require('./fabric-gateway-protocol');
const { streamBrokerResponse } = require('./fabric-broker-stream');

const DEFAULT_FABRIC_GATEWAY_TIMEOUT_MS = 120_000;

function createRequestId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return crypto.randomBytes(12).toString('hex');
}

function readGatewayHop(headers = {}) {
  return normalizeGatewayHop(headers['x-aih-gateway-hop'] || headers['X-Aih-Gateway-Hop']);
}

function gatewayTargetPath(pathname, requestUrl) {
  const basePath = String(pathname || '').trim() || '/';
  try {
    const parsed = new URL(String(requestUrl || basePath), 'http://gateway.local');
    return `${basePath}${parsed.search || ''}`;
  } catch (_error) {
    return basePath;
  }
}

function gatewayRequestHeaders(headers = {}, hop) {
  return {
    ...pickFabricGatewayHeaders(headers),
    'x-aih-gateway-hop': String(hop)
  };
}

function writeGatewayError(res, writeJson, statusCode, error, detail = {}) {
  if (res.headersSent || res.writableEnded) return;
  if (typeof writeJson === 'function') {
    writeJson(res, statusCode, { ok: false, error, ...detail });
    return;
  }
  res.statusCode = statusCode;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ ok: false, error, ...detail }));
}

function hasLocalProviderAccounts(state) {
  return SUPPORTED_SERVER_PROVIDERS.some((provider) => (
    Array.isArray(state?.accounts?.[provider]) && state.accounts[provider].length > 0
  ));
}

async function proxyFabricGatewayRequest(input = {}, deps = {}) {
  if (hasLocalProviderAccounts(input.state)) {
    return { handled: false, reason: 'local_accounts_present' };
  }

  const currentHop = readGatewayHop(input.req && input.req.headers);
  if (currentHop >= MAX_FABRIC_GATEWAY_HOPS) {
    return { handled: false, reason: 'gateway_hop_limit_reached' };
  }

  const brokerRegistry = deps.fabricBrokerSessionRegistry;
  const servers = brokerRegistry && typeof brokerRegistry.listBrokerServers === 'function'
    ? brokerRegistry.listBrokerServers()
    : [];
  const server = selectFabricGatewayServer(servers, input.model, input.provider);
  if (!server) return { handled: false, reason: 'fabric_gateway_unavailable' };

  const session = brokerRegistry.getBrokerSession(server.stableServerId);
  const socket = session && session.socket;
  if (!session || !socket || (socket.readyState !== undefined && socket.readyState !== 1)) {
    return { handled: false, reason: 'fabric_gateway_offline' };
  }

  const releaseSlot = acquireFabricGatewaySlot(
    server.stableServerId,
    deps.fabricGatewayMaxConcurrentRequests
  );
  if (!releaseSlot) {
    if (input.res && typeof input.res.setHeader === 'function') {
      input.res.setHeader('retry-after', '1');
    }
    writeGatewayError(input.res, deps.writeJson, 429, 'fabric_gateway_concurrency_limited', {
      gatewayServerId: server.stableServerId
    });
    return { handled: true, serverId: server.stableServerId, reason: 'concurrency_limited' };
  }

  const requestId = createRequestId();
  const body = Buffer.isBuffer(input.bodyBuffer) ? input.bodyBuffer : Buffer.alloc(0);
  const requestFrame = {
    type: 'broker.request',
    purpose: FABRIC_GATEWAY_REQUEST_PURPOSE,
    gatewayProtocolVersion: FABRIC_GATEWAY_PROTOCOL_VERSION,
    requestId,
    method: String(input.method || 'POST').toUpperCase(),
    pathname: gatewayTargetPath(input.pathname, input.req && input.req.url),
    headers: gatewayRequestHeaders(input.req && input.req.headers, currentHop + 1),
    bodyBase64: body.length > 0 ? body.toString('base64') : ''
  };

  try {
    const streamResult = await (deps.streamBrokerResponse || streamBrokerResponse)({
      socket,
      requestId,
      serverId: server.stableServerId,
      res: input.res,
      requestFrame,
      timeoutMs: Math.max(
        1000,
        Number(deps.fabricGatewayRequestTimeoutMs) || DEFAULT_FABRIC_GATEWAY_TIMEOUT_MS
      )
    });
    if (streamResult && streamResult.cancelled) {
      return { handled: true, serverId: server.stableServerId, reason: 'client_cancelled' };
    }
    return { handled: true, serverId: server.stableServerId, reason: 'proxied' };
  } catch (error) {
    writeGatewayError(input.res, deps.writeJson, 502, String(
      (error && error.code) || 'fabric_gateway_request_failed'
    ), {
      gatewayServerId: server.stableServerId,
      retryable: true
    });
    return { handled: true, serverId: server.stableServerId, reason: 'proxy_failed' };
  } finally {
    releaseSlot();
  }
}

module.exports = {
  DEFAULT_FABRIC_GATEWAY_CONCURRENCY,
  DEFAULT_FABRIC_GATEWAY_TIMEOUT_MS,
  gatewayRequestHeaders,
  gatewayTargetPath,
  hasLocalProviderAccounts,
  proxyFabricGatewayRequest,
  readGatewayHop
};
