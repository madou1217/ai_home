'use strict';

const http = require('node:http');
const { pipeline } = require('node:stream');

const {
  listManagedFrpRoutes,
  normalizeStableServerId
} = require('./frp-route-registry');
const {
  canonicalizeFabricProxyTargetPath
} = require('./fabric-proxy-path');

const FABRIC_FRP_PROXY_PREFIX = '/v0/fabric/frp/servers/';
const DEFAULT_FRP_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_FRP_VERIFY_TIMEOUT_MS = 3_000;
const DEFAULT_FRP_MAX_CONCURRENT_REQUESTS = 16;
const MAX_FRP_BODY_BYTES = 10 * 1024 * 1024;
const MAX_FRP_DESCRIPTOR_BYTES = 64 * 1024;
const activeRequestsByServerId = new Map();
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
]);
const RESPONSE_HEADER_ALLOWLIST = new Set([
  'accept-ranges',
  'access-control-allow-credentials',
  'access-control-allow-headers',
  'access-control-allow-methods',
  'access-control-allow-origin',
  'access-control-expose-headers',
  'access-control-max-age',
  'age',
  'allow',
  'cache-control',
  'content-disposition',
  'content-encoding',
  'content-language',
  'content-length',
  'content-range',
  'content-security-policy',
  'content-security-policy-report-only',
  'content-type',
  'cross-origin-embedder-policy',
  'cross-origin-opener-policy',
  'cross-origin-resource-policy',
  'etag',
  'expires',
  'last-modified',
  'permissions-policy',
  'pragma',
  'referrer-policy',
  'retry-after',
  'server-timing',
  'vary',
  'x-aih-request-id',
  'x-content-type-options',
  'x-frame-options'
]);
const ROUTE_HEALTH = new Set(['healthy', 'degraded', 'offline', 'unknown']);

function normalizeVisitorRoute(value) {
  const source = value && typeof value === 'object' ? value : {};
  const stableServerId = normalizeStableServerId(source.stableServerId || source.serverId);
  const bindPort = Number(source.bindPort);
  if (!stableServerId || !Number.isInteger(bindPort) || bindPort <= 0 || bindPort > 65535) return null;
  const name = String(source.name || stableServerId).trim().slice(0, 120) || stableServerId;
  const health = String(source.health || 'unknown').trim().toLowerCase();
  return {
    stableServerId,
    name,
    bindPort,
    health: ROUTE_HEALTH.has(health) ? health : 'unknown'
  };
}

function normalizeVisitorRoutes(values) {
  const routesByServerId = new Map();
  const conflictingServerIds = new Set();
  (Array.isArray(values) ? values : []).forEach((value) => {
    const route = normalizeVisitorRoute(value);
    if (!route || conflictingServerIds.has(route.stableServerId)) return;
    const existing = routesByServerId.get(route.stableServerId);
    if (existing && existing.bindPort !== route.bindPort) {
      routesByServerId.delete(route.stableServerId);
      conflictingServerIds.add(route.stableServerId);
      return;
    }
    routesByServerId.set(route.stableServerId, route);
  });
  return Array.from(routesByServerId.values());
}

function listFrpVisitorRoutes(ctx = {}) {
  const deps = ctx.deps || {};
  const values = typeof deps.listFrpVisitorRoutes === 'function'
    ? deps.listFrpVisitorRoutes()
    : listManagedFrpRoutes({
      fs: deps.fs,
      aiHomeDir: deps.aiHomeDir
    }, {
      readJsonValue: deps.readJsonValue,
      nowMs: deps.nowMs
    });
  return normalizeVisitorRoutes(values);
}

function buildFrpPublicRoute(visitor) {
  return {
    kind: 'frp',
    path: `${FABRIC_FRP_PROXY_PREFIX}${encodeURIComponent(visitor.stableServerId)}/proxy`,
    health: visitor.health
  };
}

function mergeFabricServersWithFrpRoutes(servers, visitors) {
  const merged = [];
  const indexByServerId = new Map();
  (Array.isArray(servers) ? servers : []).forEach((server) => {
    const stableServerId = normalizeStableServerId(server && (server.stableServerId || server.serverId));
    if (!stableServerId) return;
    indexByServerId.set(stableServerId, merged.length);
    merged.push({
      ...server,
      stableServerId,
      routes: Array.isArray(server.routes) ? server.routes.slice() : []
    });
  });
  normalizeVisitorRoutes(visitors).forEach((visitor) => {
    const route = buildFrpPublicRoute(visitor);
    const existingIndex = indexByServerId.get(visitor.stableServerId);
    if (existingIndex === undefined) {
      indexByServerId.set(visitor.stableServerId, merged.length);
      merged.push({
        stableServerId: visitor.stableServerId,
        name: visitor.name,
        capabilities: {},
        routes: [route]
      });
      return;
    }
    const server = merged[existingIndex];
    const routeIndex = server.routes.findIndex((item) => item
      && item.kind === route.kind
      && item.path === route.path);
    if (routeIndex === -1) server.routes.push(route);
    else server.routes[routeIndex] = route;
  });
  return merged;
}

function parseFrpProxyPath(pathname, search = '') {
  const raw = String(pathname || '');
  if (!raw.startsWith(FABRIC_FRP_PROXY_PREFIX)) return null;
  const rest = raw.slice(FABRIC_FRP_PROXY_PREFIX.length);
  const parts = rest.split('/');
  let decodedServerId = '';
  try {
    decodedServerId = decodeURIComponent(parts.shift() || '');
  } catch (_error) {
    return { matched: true, valid: false };
  }
  const stableServerId = normalizeStableServerId(decodedServerId);
  if (!stableServerId || parts.shift() !== 'proxy') {
    return { matched: true, valid: false };
  }
  const rawTargetPath = `${(`/${parts.join('/')}`.replace(/\/+$/, '') || '/')}${String(search || '')}`;
  const targetPath = canonicalizeFabricProxyTargetPath(rawTargetPath);
  return {
    matched: true,
    valid: true,
    stableServerId,
    targetPath
  };
}

function responseConnectionHeaders(headers = {}) {
  const value = Array.isArray(headers.connection)
    ? headers.connection.join(',')
    : String(headers.connection || '');
  return new Set(value.split(',').map((name) => name.trim().toLowerCase()).filter(Boolean));
}

function copyUpstreamResponseHeaders(upstream, res, stableServerId) {
  const headers = upstream && upstream.headers ? upstream.headers : {};
  const connectionHeaders = responseConnectionHeaders(headers);
  Object.entries(headers).forEach(([name, value]) => {
    const lowerName = String(name).toLowerCase();
    if (value === undefined
      || !RESPONSE_HEADER_ALLOWLIST.has(lowerName)
      || HOP_BY_HOP_HEADERS.has(lowerName)
      || connectionHeaders.has(lowerName)) return;
    res.setHeader(lowerName, value);
  });
  res.setHeader('x-aih-frp-server-id', stableServerId);
}

function createFrpProxyError(code, responseStarted = false) {
  const error = new Error(code);
  error.code = code;
  error.responseStarted = responseStarted;
  return error;
}

function verifyFrpVisitorIdentity(visitor, options = {}) {
  const timeoutMs = Math.max(250, Number(options.timeoutMs) || DEFAULT_FRP_VERIFY_TIMEOUT_MS);
  return new Promise((resolve, reject) => {
    let settled = false;
    const request = http.request({
      hostname: '127.0.0.1',
      port: visitor.bindPort,
      method: 'GET',
      path: '/v0/fabric/descriptor',
      headers: { accept: 'application/json' },
      signal: options.signal
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_FRP_DESCRIPTOR_BYTES) {
          response.destroy();
          finish(reject, createFrpProxyError('fabric_frp_server_identity_unavailable'));
          return;
        }
        chunks.push(chunk);
      });
      response.once('error', () => {
        finish(reject, createFrpProxyError('fabric_frp_server_identity_unavailable'));
      });
      response.once('end', () => {
        if (Number(response.statusCode) !== 200) {
          finish(reject, createFrpProxyError('fabric_frp_server_identity_unavailable'));
          return;
        }
        let payload = null;
        try {
          payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch (_error) {
          finish(reject, createFrpProxyError('fabric_frp_server_identity_unavailable'));
          return;
        }
        const descriptor = payload && payload.result && typeof payload.result === 'object'
          ? payload.result
          : payload;
        const service = String(descriptor && descriptor.service || '');
        const serverId = normalizeStableServerId(descriptor && descriptor.server && descriptor.server.id);
        if (service !== 'aih-fabric' || serverId !== visitor.stableServerId) {
          finish(reject, createFrpProxyError('fabric_frp_server_identity_mismatch'));
          return;
        }
        finish(resolve, { ok: true, stableServerId: serverId });
      });
    });

    function finish(callback, value) {
      if (settled) return;
      settled = true;
      request.setTimeout(0);
      callback(value);
    }

    request.setTimeout(timeoutMs, () => {
      request.destroy(createFrpProxyError('fabric_frp_server_identity_unavailable'));
    });
    request.once('error', (error) => {
      finish(reject, error && String(error.code || '').startsWith('fabric_frp_')
        ? error
        : createFrpProxyError('fabric_frp_server_identity_unavailable'));
    });
    request.end();
  });
}

function forwardFrpRequest(input = {}) {
  const {
    req,
    res,
    method,
    targetPath,
    bindPort,
    stableServerId,
    headers,
    body
  } = input;
  const timeoutMs = Math.max(1000, Number(input.timeoutMs) || DEFAULT_FRP_REQUEST_TIMEOUT_MS);

  return new Promise((resolve, reject) => {
    let settled = false;
    let responseStarted = false;
    let upstream = null;
    let clientDisconnected = false;

    function cleanupClientListeners() {
      if (req && typeof req.off === 'function') req.off('aborted', onClientDisconnect);
      if (res && typeof res.off === 'function') res.off('close', onClientDisconnect);
    }

    function finish(callback, value) {
      if (settled) return;
      settled = true;
      cleanupClientListeners();
      callback(value);
    }

    function onClientDisconnect() {
      if (settled || (res && res.writableEnded)) return;
      clientDisconnected = true;
      if (upstream && !upstream.destroyed) upstream.destroy();
      if (!localRequest.destroyed) localRequest.destroy();
      finish(resolve, { ok: false, cancelled: true, responseStarted });
    }

    const localRequest = http.request({
      hostname: '127.0.0.1',
      port: bindPort,
      method,
      path: targetPath,
      headers
    }, (localResponse) => {
      upstream = localResponse;
      responseStarted = true;
      localRequest.setTimeout(0);
      res.statusCode = Number(localResponse.statusCode) || 502;
      copyUpstreamResponseHeaders(localResponse, res, stableServerId);
      if (typeof res.flushHeaders === 'function') res.flushHeaders();
      pipeline(localResponse, res, (error) => {
        if (clientDisconnected) {
          finish(resolve, { ok: false, cancelled: true, responseStarted: true });
          return;
        }
        if (error) {
          finish(reject, createFrpProxyError('fabric_frp_stream_failed', true));
          return;
        }
        finish(resolve, { ok: true, responseStarted: true });
      });
    });

    if (req && typeof req.once === 'function') req.once('aborted', onClientDisconnect);
    if (res && typeof res.once === 'function') res.once('close', onClientDisconnect);
    localRequest.setTimeout(timeoutMs, () => {
      localRequest.destroy(createFrpProxyError('fabric_frp_request_timeout', responseStarted));
    });
    localRequest.once('error', (error) => {
      if (clientDisconnected) {
        finish(resolve, { ok: false, cancelled: true, responseStarted });
        return;
      }
      const code = error && error.code === 'fabric_frp_request_timeout'
        ? error.code
        : 'fabric_frp_upstream_unavailable';
      finish(reject, createFrpProxyError(code, responseStarted));
    });
    localRequest.end(body && body.length > 0 ? body : undefined);
  });
}

function acquireFrpRequestSlot(stableServerId, maxConcurrent) {
  const key = String(stableServerId || '');
  const active = activeRequestsByServerId.get(key) || 0;
  if (!key || active >= maxConcurrent) return null;
  activeRequestsByServerId.set(key, active + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = Math.max(0, (activeRequestsByServerId.get(key) || 1) - 1);
    if (remaining === 0) activeRequestsByServerId.delete(key);
    else activeRequestsByServerId.set(key, remaining);
  };
}

function boundedPositiveInteger(value, fallback, maximum) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric <= 0) return fallback;
  return Math.min(numeric, maximum);
}

function createClientDisconnectMonitor(req, res) {
  let disconnected = Boolean((req && req.aborted) || (res && res.destroyed));
  let rejectDisconnect = null;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const promise = new Promise((_, reject) => {
    rejectDisconnect = reject;
  });

  function onDisconnect() {
    if (disconnected || (res && res.writableEnded)) return;
    disconnected = true;
    if (controller) controller.abort();
    rejectDisconnect(createFrpProxyError('fabric_frp_client_disconnected'));
  }

  if (req && typeof req.once === 'function') req.once('aborted', onDisconnect);
  if (res && typeof res.once === 'function') res.once('close', onDisconnect);
  if (disconnected) onDisconnect();

  return {
    promise,
    signal: controller ? controller.signal : undefined,
    isDisconnected: () => disconnected,
    cleanup() {
      if (req && typeof req.off === 'function') req.off('aborted', onDisconnect);
      if (res && typeof res.off === 'function') res.off('close', onDisconnect);
    }
  };
}

async function handleFabricFrpProxyRequest(ctx = {}, options = {}) {
  const parsed = parseFrpProxyPath(ctx.pathname, ctx.url && ctx.url.search);
  if (!parsed) return false;
  if (!parsed.valid) {
    ctx.deps.writeJson(ctx.res, 404, { ok: false, error: 'fabric_frp_route_not_found' });
    return true;
  }

  const method = String(ctx.method || 'GET').toUpperCase();
  const isRouteAllowed = options.isRouteAllowed;
  if (!parsed.targetPath
    || typeof isRouteAllowed !== 'function'
    || !isRouteAllowed(method, parsed.targetPath)) {
    ctx.deps.writeJson(ctx.res, 403, { ok: false, error: 'fabric_frp_route_not_allowed' });
    return true;
  }

  const visitor = listFrpVisitorRoutes(ctx)
    .find((route) => route.stableServerId === parsed.stableServerId);
  if (!visitor) {
    ctx.deps.writeJson(ctx.res, 404, {
      ok: false,
      error: 'fabric_frp_server_not_found',
      stableServerId: parsed.stableServerId
    });
    return true;
  }

  const maxConcurrent = boundedPositiveInteger(
    ctx.deps.frpProxyMaxConcurrentRequests,
    DEFAULT_FRP_MAX_CONCURRENT_REQUESTS,
    128
  );
  const releaseSlot = acquireFrpRequestSlot(visitor.stableServerId, maxConcurrent);
  if (!releaseSlot) {
    if (ctx.req && typeof ctx.req.resume === 'function') ctx.req.resume();
    if (ctx.res && typeof ctx.res.setHeader === 'function') ctx.res.setHeader('retry-after', '1');
    ctx.deps.writeJson(ctx.res, 429, { ok: false, error: 'fabric_frp_concurrency_limited' });
    return true;
  }
  const disconnectMonitor = createClientDisconnectMonitor(ctx.req, ctx.res);

  try {
    if (disconnectMonitor.isDisconnected()) return true;
    try {
      const verify = typeof ctx.deps.verifyFrpVisitorIdentity === 'function'
        ? ctx.deps.verifyFrpVisitorIdentity
        : verifyFrpVisitorIdentity;
      await Promise.race([
        verify(visitor, {
          timeoutMs: ctx.deps.frpVisitorVerifyTimeoutMs,
          signal: disconnectMonitor.signal
        }),
        disconnectMonitor.promise
      ]);
    } catch (error) {
      if (disconnectMonitor.isDisconnected()) return true;
      if (ctx.req && typeof ctx.req.resume === 'function') ctx.req.resume();
      ctx.deps.writeJson(ctx.res, 502, {
        ok: false,
        error: String(error && error.code || 'fabric_frp_server_identity_unavailable')
      });
      return true;
    }

    let body = Buffer.alloc(0);
    if (method !== 'GET' && method !== 'HEAD') {
      const maxBodyBytes = boundedPositiveInteger(
        ctx.deps.frpProxyMaxBodyBytes,
        MAX_FRP_BODY_BYTES,
        MAX_FRP_BODY_BYTES
      );
      try {
        body = await Promise.race([
          ctx.deps.readRequestBody(ctx.req, { maxBytes: maxBodyBytes }),
          disconnectMonitor.promise
        ]);
      } catch (error) {
        if (disconnectMonitor.isDisconnected()) return true;
        if (ctx.req && typeof ctx.req.resume === 'function') ctx.req.resume();
        const bodyTooLarge = error && (error.code === 'request_body_too_large'
          || error.message === 'request_body_too_large');
        ctx.deps.writeJson(ctx.res, bodyTooLarge ? 413 : 400, {
          ok: false,
          error: bodyTooLarge ? 'fabric_frp_body_too_large' : 'fabric_frp_invalid_body'
        });
        return true;
      }
    }

    disconnectMonitor.cleanup();
    if (disconnectMonitor.isDisconnected() || ctx.res.destroyed) return true;
    const pickForwardHeaders = options.pickForwardHeaders;
    try {
      await forwardFrpRequest({
        req: ctx.req,
        res: ctx.res,
        method,
        targetPath: parsed.targetPath,
        bindPort: visitor.bindPort,
        stableServerId: visitor.stableServerId,
        headers: typeof pickForwardHeaders === 'function'
          ? pickForwardHeaders(ctx.req && ctx.req.headers)
          : {},
        body,
        timeoutMs: ctx.deps.frpRequestTimeoutMs
      });
    } catch (error) {
      if (!error.responseStarted && !ctx.res.headersSent && !ctx.res.writableEnded && !ctx.res.destroyed) {
        const statusCode = error.code === 'fabric_frp_request_timeout' ? 504 : 502;
        ctx.deps.writeJson(ctx.res, statusCode, {
          ok: false,
          error: String(error.code || 'fabric_frp_proxy_failed')
        });
      } else if (!ctx.res.writableEnded && !ctx.res.destroyed && typeof ctx.res.destroy === 'function') {
        ctx.res.destroy();
      }
    }
    return true;
  } finally {
    disconnectMonitor.cleanup();
    releaseSlot();
  }
}

module.exports = {
  DEFAULT_FRP_REQUEST_TIMEOUT_MS,
  DEFAULT_FRP_MAX_CONCURRENT_REQUESTS,
  DEFAULT_FRP_VERIFY_TIMEOUT_MS,
  FABRIC_FRP_PROXY_PREFIX,
  buildFrpPublicRoute,
  canonicalizeFrpTargetPath: canonicalizeFabricProxyTargetPath,
  handleFabricFrpProxyRequest,
  listFrpVisitorRoutes,
  mergeFabricServersWithFrpRoutes,
  normalizeVisitorRoutes,
  parseFrpProxyPath,
  verifyFrpVisitorIdentity
};
