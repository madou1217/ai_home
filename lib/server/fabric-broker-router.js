'use strict';

const crypto = require('node:crypto');
const {
  createFabricBrokerSessionRegistry,
  normalizeFabricServerId
} = require('./fabric-broker-session-registry');

const FABRIC_BROKER_CONTROL_PATH = '/v0/fabric/broker/control';
const FABRIC_BROKER_PROXY_PREFIX = '/v0/fabric/broker/servers/';
const DEFAULT_BROKER_REQUEST_TIMEOUT_MS = 30_000;
const MAX_BROKER_BODY_BYTES = 10 * 1024 * 1024;
const sharedBrokerSessionRegistry = createFabricBrokerSessionRegistry();

function createBrokerRequestId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return crypto.randomBytes(12).toString('hex');
}

function parseJsonMessage(data) {
  try {
    return JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data || ''));
  } catch (_error) {
    return null;
  }
}

function sendJson(socket, payload) {
  if (!socket || socket.readyState !== 1) return false;
  try {
    socket.send(JSON.stringify(payload));
    return true;
  } catch (_error) {
    return false;
  }
}

function writeUpgradeError(socket, statusCode, reason) {
  if (!socket || socket.destroyed) return;
  const statusText = {
    400: 'Bad Request',
    401: 'Unauthorized',
    500: 'Internal Server Error'
  }[statusCode] || 'Bad Gateway';
  const body = JSON.stringify({ ok: false, error: reason || statusText });
  socket.write(
    `HTTP/1.1 ${statusCode} ${statusText}\r\n`
      + 'content-type: application/json\r\n'
      + `content-length: ${Buffer.byteLength(body)}\r\n`
      + 'connection: close\r\n\r\n'
      + body
  );
  socket.destroy();
}

function bearerFromRequest(req, deps = {}) {
  if (typeof deps.parseAuthorizationBearer === 'function') {
    return deps.parseAuthorizationBearer(req.headers.authorization);
  }
  const match = String((req.headers && req.headers.authorization) || '').match(/^Bearer\s+(.+)$/i);
  return match ? String(match[1] || '').trim() : '';
}

function expectedBrokerToken(deps = {}) {
  const env = deps.env || process.env || {};
  return String(
    deps.brokerToken
      || env.AIH_FABRIC_BROKER_TOKEN
      || deps.requiredManagementKey
      || ''
  ).trim();
}

function parseBrokerControlRequest(req) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  return {
    serverId: normalizeFabricServerId(url.searchParams.get('serverId') || req.headers['x-aih-server-id']),
    pathname: url.pathname
  };
}

function authorizeBrokerControl(req, deps = {}) {
  const parsed = parseBrokerControlRequest(req);
  if (!parsed.serverId) {
    return { ok: false, statusCode: 400, error: 'missing_broker_server_id' };
  }
  const expected = expectedBrokerToken(deps);
  if (!expected) {
    return { ok: false, statusCode: 401, error: 'broker_token_required' };
  }
  if (bearerFromRequest(req, deps) !== expected) {
    return { ok: false, statusCode: 401, error: 'unauthorized_broker_server' };
  }
  return { ok: true, serverId: parsed.serverId };
}

function parseBrokerProxyPath(pathname, search = '') {
  const raw = String(pathname || '');
  if (!raw.startsWith(FABRIC_BROKER_PROXY_PREFIX)) return null;
  const rest = raw.slice(FABRIC_BROKER_PROXY_PREFIX.length);
  const parts = rest.split('/');
  const serverId = normalizeFabricServerId(parts.shift());
  if (!serverId || parts.shift() !== 'proxy') return null;
  const targetPath = `/${parts.join('/')}`.replace(/\/+$/, '') || '/';
  return {
    serverId,
    targetPath: `${targetPath}${String(search || '')}`
  };
}

function parseBrokerRoutePath(value) {
  try {
    const url = new URL(String(value || ''), 'http://broker.local');
    return {
      pathname: url.pathname || '/',
      search: url.search || ''
    };
  } catch (_error) {
    return { pathname: '', search: '' };
  }
}

function isFabricBrokerRouteAllowed(method, pathname) {
  const requestMethod = String(method || 'GET').toUpperCase();
  const parsed = parseBrokerRoutePath(pathname);
  const path = parsed.pathname;
  if (requestMethod === 'GET') {
    return path === '/readyz'
      || path === '/v0/fabric/descriptor'
      || path === '/v0/fabric/registry'
      || path === '/v0/fabric/registry/nodes'
      || path === '/v0/node-rpc/device-profile'
      || path === '/v0/node-rpc/device-status'
      || path === '/v0/node-rpc/device-accounts'
      || path === '/v0/node-rpc/device-sessions'
      || path === '/v0/node-rpc/device-nodes'
      || path === '/v0/node-rpc/device-node-sessions'
      || path === '/v0/node-rpc/device-node-session-catalog'
      || path === '/v0/node-rpc/device-node-session-run-events';
  }
  if (requestMethod === 'POST') {
    return path === '/v0/fabric/device-pair'
      || path === '/v0/fabric/registry/nodes'
      || path === '/v0/fabric/registry/heartbeat'
      || path === '/v0/node-rpc/device-node-session-start'
      || path === '/v0/node-rpc/device-node-session-attach'
      || path === '/v0/node-rpc/device-node-session-run-input'
      || path === '/v0/node-rpc/device-node-session-run-abort';
  }
  return false;
}

function pickForwardHeaders(headers = {}) {
  const out = {};
  [
    'authorization',
    'content-type',
    'accept',
    'x-aih-device-id',
    'x-aih-request-id'
  ].forEach((name) => {
    const value = headers[name];
    if (value === undefined) return;
    out[name] = Array.isArray(value) ? value.join(', ') : String(value);
  });
  return out;
}

function pickResponseHeaders(headers = {}) {
  const out = {};
  [
    'content-type',
    'cache-control'
  ].forEach((name) => {
    const value = headers[name];
    if (value === undefined) return;
    out[name] = Array.isArray(value) ? value.join(', ') : String(value);
  });
  return out;
}

function waitForBrokerResponse(socket, requestId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      const error = new Error('broker_request_timeout');
      error.code = 'broker_request_timeout';
      reject(error);
    }, timeoutMs);
    if (timer && typeof timer.unref === 'function') timer.unref();

    function cleanup() {
      clearTimeout(timer);
      socket.off('message', onMessage);
      socket.off('close', onClose);
      socket.off('error', onError);
    }
    function onMessage(data) {
      const message = parseJsonMessage(data);
      if (!message || message.type !== 'broker.response' || message.requestId !== requestId) return;
      cleanup();
      resolve(message);
    }
    function onClose() {
      cleanup();
      const error = new Error('broker_server_link_closed');
      error.code = 'broker_server_link_closed';
      reject(error);
    }
    function onError() {
      cleanup();
      const error = new Error('broker_server_link_error');
      error.code = 'broker_server_link_error';
      reject(error);
    }

    socket.on('message', onMessage);
    socket.once('close', onClose);
    socket.once('error', onError);
  });
}

async function handleFabricBrokerProxyRequest(ctx = {}) {
  const parsed = parseBrokerProxyPath(ctx.pathname, ctx.url && ctx.url.search);
  if (!parsed) return false;

  const method = String(ctx.method || 'GET').toUpperCase();
  if (!isFabricBrokerRouteAllowed(method, parsed.targetPath)) {
    ctx.deps.writeJson(ctx.res, 403, {
      ok: false,
      error: 'fabric_broker_route_not_allowed'
    });
    return true;
  }

  const registry = ctx.deps.fabricBrokerSessionRegistry || sharedBrokerSessionRegistry;
  const session = registry.getBrokerSession(parsed.serverId);
  const socket = session && session.socket;
  if (!session || !socket || socket.readyState !== 1) {
    const brokerStatus = typeof registry.getBrokerServerStatus === 'function'
      ? registry.getBrokerServerStatus(parsed.serverId)
      : { serverId: parsed.serverId, online: false, session: null, lastDisconnected: null };
    ctx.deps.writeJson(ctx.res, 503, {
      ok: false,
      error: 'fabric_broker_server_offline',
      serverId: parsed.serverId,
      brokerStatus
    });
    return true;
  }

  const body = method === 'GET' || method === 'HEAD'
    ? Buffer.alloc(0)
    : await ctx.deps.readRequestBody(ctx.req, { maxBytes: MAX_BROKER_BODY_BYTES }).catch(() => null);
  if (body === null) {
    ctx.deps.writeJson(ctx.res, 400, { ok: false, error: 'fabric_broker_invalid_body' });
    return true;
  }

  const requestId = createBrokerRequestId();
  const timeoutMs = Math.max(1000, Number(ctx.deps.brokerRequestTimeoutMs) || DEFAULT_BROKER_REQUEST_TIMEOUT_MS);
  const responsePromise = waitForBrokerResponse(socket, requestId, timeoutMs);
  if (!sendJson(socket, {
    type: 'broker.request',
    requestId,
    method,
    pathname: parsed.targetPath,
    headers: pickForwardHeaders(ctx.req && ctx.req.headers),
    bodyBase64: body.length > 0 ? body.toString('base64') : ''
  })) {
    ctx.deps.writeJson(ctx.res, 503, { ok: false, error: 'fabric_broker_send_failed' });
    return true;
  }

  try {
    const response = await responsePromise;
    const status = Number(response.status || 502);
    const headers = pickResponseHeaders(response.headers || {});
    Object.keys(headers).forEach((name) => ctx.res.setHeader(name, headers[name]));
    ctx.res.setHeader('cache-control', headers['cache-control'] || 'no-store');
    ctx.res.setHeader('x-aih-fabric-broker-server-id', parsed.serverId);
    const responseBody = response.bodyBase64
      ? Buffer.from(String(response.bodyBase64), 'base64')
      : Buffer.alloc(0);
    ctx.res.statusCode = status;
    ctx.res.end(responseBody);
  } catch (error) {
    ctx.deps.writeJson(ctx.res, 504, {
      ok: false,
      error: String((error && error.code) || 'fabric_broker_request_failed')
    });
  }
  return true;
}

function attachBrokerHeartbeat(session, registry) {
  const socket = session.socket;
  if (!socket || typeof socket.on !== 'function') return;
  socket.on('message', (data) => {
    const message = parseJsonMessage(data);
    if (!message || typeof message !== 'object') return;
    if (message.type === 'broker.ping' || message.type === 'broker.heartbeat') {
      const touched = registry.touchBrokerSession(session.sessionId);
      sendJson(socket, {
        type: 'broker.pong',
        ok: true,
        serverId: session.serverId,
        sessionId: session.sessionId,
        serverTime: touched ? touched.lastSeenAt : Date.now()
      });
    }
  });
}

function handleFabricBrokerControlUpgrade(input = {}) {
  const { req, socket, head } = input;
  const deps = input.deps || {};
  const WebSocket = deps.WebSocket;
  if (!WebSocket || !WebSocket.Server) {
    writeUpgradeError(socket, 500, 'websocket_unavailable');
    return true;
  }

  const authorization = authorizeBrokerControl(req, deps);
  if (!authorization.ok) {
    writeUpgradeError(socket, authorization.statusCode, authorization.error);
    return true;
  }

  const registry = deps.fabricBrokerSessionRegistry || sharedBrokerSessionRegistry;
  const wss = new WebSocket.Server({ noServer: true });
  wss.handleUpgrade(req, socket, head, (client) => {
    const session = registry.registerBrokerSession({
      serverId: authorization.serverId,
      socket: client,
      remoteAddress: String(deps.clientIp || (req.socket && req.socket.remoteAddress) || '').trim()
    });

    const markDisconnected = (reason, closeCode, closeReason) => {
      const current = registry.getBrokerSession(authorization.serverId);
      if (!current || current.sessionId !== session.sessionId) return;
      registry.removeBrokerSession(session.sessionId, {
        reason,
        closeCode,
        closeReason
      });
    };

    attachBrokerHeartbeat(session, registry);
    client.on('close', (code, reason) => {
      markDisconnected('broker_server_link_closed', code, Buffer.isBuffer(reason) ? reason.toString('utf8') : reason);
    });
    client.on('error', (error) => {
      markDisconnected('broker_server_link_error', 0, error && error.message);
    });
    sendJson(client, {
      type: 'broker.hello',
      ok: true,
      serverId: authorization.serverId,
      sessionId: session.sessionId,
      serverTime: Date.now()
    });
  });
  return true;
}

module.exports = {
  FABRIC_BROKER_CONTROL_PATH,
  DEFAULT_BROKER_REQUEST_TIMEOUT_MS,
  authorizeBrokerControl,
  handleFabricBrokerControlUpgrade,
  handleFabricBrokerProxyRequest,
  isFabricBrokerRouteAllowed,
  parseBrokerProxyPath,
  pickForwardHeaders,
  pickResponseHeaders
};
