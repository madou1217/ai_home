'use strict';

const crypto = require('node:crypto');
const { authorizeManagementKey } = require('./management-key-auth');
const {
  createFabricBrokerSessionRegistry,
  normalizeFabricServerId
} = require('./fabric-broker-session-registry');
const { streamBrokerResponse } = require('./fabric-broker-stream');
const {
  handleFabricFrpProxyRequest,
  listFrpVisitorRoutes,
  mergeFabricServersWithFrpRoutes
} = require('./frp-proxy-router');
const {
  canonicalizeFabricProxyTargetPath
} = require('./fabric-proxy-path');

const FABRIC_BROKER_CONTROL_PATH = '/v0/fabric/broker/control';
const FABRIC_BROKER_DIRECTORY_PATH = '/v0/fabric/broker/servers';
const FABRIC_BROKER_PROXY_PREFIX = '/v0/fabric/broker/servers/';
const DEFAULT_BROKER_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_BROKER_MAX_CONCURRENT_REQUESTS = 16;
const MAX_BROKER_BODY_BYTES = 10 * 1024 * 1024;
const sharedBrokerSessionRegistry = createFabricBrokerSessionRegistry();
const activeBrokerRequestsByServerId = new Map();

function acquireBrokerRequestSlot(serverId, requestedLimit) {
  const limitValue = Number(requestedLimit);
  const limit = Number.isInteger(limitValue) && limitValue > 0
    ? Math.min(limitValue, 128)
    : DEFAULT_BROKER_MAX_CONCURRENT_REQUESTS;
  const active = activeBrokerRequestsByServerId.get(serverId) || 0;
  if (active >= limit) return null;
  activeBrokerRequestsByServerId.set(serverId, active + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = Math.max(0, (activeBrokerRequestsByServerId.get(serverId) || 1) - 1);
    if (remaining === 0) activeBrokerRequestsByServerId.delete(serverId);
    else activeBrokerRequestsByServerId.set(serverId, remaining);
  };
}

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
  const gate = authorizeManagementKey({
    req,
    credential: bearerFromRequest(req, deps),
    requiredManagementKey: deps.requiredManagementKey,
    deps
  });
  if (!gate.ok) return gate;
  return { ok: true, serverId: parsed.serverId };
}

function buildBrokerRelayRoute(serverId) {
  return {
    kind: 'relay',
    path: `${FABRIC_BROKER_PROXY_PREFIX}${encodeURIComponent(serverId)}/proxy`
  };
}

function appendBrokerRelayRoute(server) {
  const route = buildBrokerRelayRoute(server.stableServerId);
  const routes = Array.isArray(server.routes) ? server.routes.slice() : [];
  if (!routes.some((item) => item && item.kind === route.kind && item.path === route.path)) {
    routes.push(route);
  }
  return { ...server, routes };
}

function handleFabricBrokerDirectoryRequest(ctx = {}) {
  if (String(ctx.method || 'GET').toUpperCase() !== 'GET' || ctx.pathname !== FABRIC_BROKER_DIRECTORY_PATH) {
    return false;
  }
  const gate = authorizeManagementKey({
    req: ctx.req,
    requiredManagementKey: ctx.requiredManagementKey || (ctx.deps && ctx.deps.requiredManagementKey),
    deps: ctx.deps
  });
  if (!gate.ok) {
    ctx.deps.writeJson(ctx.res, gate.statusCode, { ok: false, error: gate.error });
    return true;
  }
  const registry = ctx.deps.fabricBrokerSessionRegistry || sharedBrokerSessionRegistry;
  const brokerServers = registry.listBrokerServers().map(appendBrokerRelayRoute);
  const servers = mergeFabricServersWithFrpRoutes(
    brokerServers,
    listFrpVisitorRoutes(ctx)
  );
  ctx.deps.writeJson(ctx.res, 200, {
    ok: true,
    rpc: 'fabric.broker.servers.list',
    result: { servers }
  });
  return true;
}

function parseBrokerProxyPath(pathname, search = '') {
  const raw = String(pathname || '');
  if (!raw.startsWith(FABRIC_BROKER_PROXY_PREFIX)) return null;
  const rest = raw.slice(FABRIC_BROKER_PROXY_PREFIX.length);
  const parts = rest.split('/');
  const serverId = normalizeFabricServerId(parts.shift());
  if (!serverId || parts.shift() !== 'proxy') return null;
  const rawTargetPath = `${(`/${parts.join('/')}`.replace(/\/+$/, '') || '/')}${String(search || '')}`;
  return {
    serverId,
    targetPath: canonicalizeFabricProxyTargetPath(rawTargetPath)
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
  const canonicalPath = canonicalizeFabricProxyTargetPath(pathname);
  if (!canonicalPath || canonicalPath !== String(pathname || '')) return false;
  const parsed = parseBrokerRoutePath(canonicalPath);
  const path = parsed.pathname;
  const safeMethods = new Set(['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT']);
  if (!safeMethods.has(requestMethod)) return false;
  if ((requestMethod === 'GET' || requestMethod === 'HEAD')
    && (path === '/healthz' || path === '/readyz' || path === '/v0/fabric/descriptor')) return true;
  if (path === '/v0/webui/server-config/management-key/rotate') return false;
  return path === '/v0/webui'
    || path.startsWith('/v0/webui/')
    || path === '/v0/client'
    || path.startsWith('/v0/client/');
}

function pickForwardHeaders(headers = {}) {
  const out = {};
  [
    'authorization',
    'content-type',
    'accept',
    'if-modified-since',
    'if-none-match',
    'last-event-id',
    'range',
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
    'cache-control',
    'content-disposition',
    'content-range',
    'accept-ranges',
    'etag',
    'last-modified',
    'retry-after',
    'x-aih-request-id'
  ].forEach((name) => {
    const value = headers[name];
    if (value === undefined) return;
    out[name] = Array.isArray(value) ? value.join(', ') : String(value);
  });
  return out;
}

async function handleFabricBrokerProxyRequest(ctx = {}) {
  const handledDirectory = handleFabricBrokerDirectoryRequest(ctx);
  if (handledDirectory) return true;
  const handledFrp = await handleFabricFrpProxyRequest(ctx, {
    isRouteAllowed: isFabricBrokerRouteAllowed,
    pickForwardHeaders
  });
  if (handledFrp) return true;
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

  const releaseSlot = acquireBrokerRequestSlot(
    parsed.serverId,
    ctx.deps.brokerMaxConcurrentRequests
  );
  if (!releaseSlot) {
    if (ctx.req && typeof ctx.req.resume === 'function') ctx.req.resume();
    if (ctx.res && typeof ctx.res.setHeader === 'function') ctx.res.setHeader('retry-after', '1');
    ctx.deps.writeJson(ctx.res, 429, {
      ok: false,
      error: 'fabric_broker_concurrency_limited'
    });
    return true;
  }

  try {
    const body = method === 'GET' || method === 'HEAD'
      ? Buffer.alloc(0)
      : await ctx.deps.readRequestBody(ctx.req, { maxBytes: MAX_BROKER_BODY_BYTES }).catch(() => null);
    if (body === null) {
      ctx.deps.writeJson(ctx.res, 400, { ok: false, error: 'fabric_broker_invalid_body' });
      return true;
    }

    const requestId = createBrokerRequestId();
    const timeoutMs = Math.max(1000, Number(ctx.deps.brokerRequestTimeoutMs) || DEFAULT_BROKER_REQUEST_TIMEOUT_MS);
    const requestFrame = {
      type: 'broker.request',
      requestId,
      method,
      pathname: parsed.targetPath,
      headers: pickForwardHeaders(ctx.req && ctx.req.headers),
      bodyBase64: body.length > 0 ? body.toString('base64') : ''
    };

    try {
      await streamBrokerResponse({
        socket,
        requestId,
        serverId: parsed.serverId,
        res: ctx.res,
        timeoutMs,
        requestFrame
      });
    } catch (error) {
      if (!error.responseStarted && !ctx.res.headersSent && !ctx.res.writableEnded) {
        ctx.deps.writeJson(ctx.res, error.code === 'fabric_broker_send_failed' ? 503 : 504, {
          ok: false,
          error: String((error && error.code) || 'fabric_broker_request_failed')
        });
      } else if (!ctx.res.writableEnded && typeof ctx.res.end === 'function') {
        ctx.res.end();
      }
    }
    return true;
  } finally {
    releaseSlot();
  }
}

function attachBrokerHeartbeat(session, registry) {
  const socket = session.socket;
  if (!socket || typeof socket.on !== 'function') return;
  socket.on('message', (data) => {
    const message = parseJsonMessage(data);
    if (!message || typeof message !== 'object') return;
    if (message.type === 'broker.register') {
      const descriptor = registry.updateBrokerSessionDescriptor(session.sessionId, message.descriptor || {});
      sendJson(socket, {
        type: 'broker.registered',
        ok: Boolean(descriptor),
        serverId: session.serverId,
        sessionId: session.sessionId
      });
      return;
    }
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
  FABRIC_BROKER_DIRECTORY_PATH,
  DEFAULT_BROKER_MAX_CONCURRENT_REQUESTS,
  DEFAULT_BROKER_REQUEST_TIMEOUT_MS,
  authorizeBrokerControl,
  handleFabricBrokerControlUpgrade,
  handleFabricBrokerProxyRequest,
  isFabricBrokerRouteAllowed,
  parseBrokerProxyPath,
  pickForwardHeaders,
  pickResponseHeaders,
  streamBrokerResponse
};
