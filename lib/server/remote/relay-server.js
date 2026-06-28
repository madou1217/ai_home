'use strict';

const crypto = require('node:crypto');
const { getRemoteNode, normalizeId } = require('./node-registry');
const { readRemoteSecret } = require('./secret-store');
const { upsertRemoteTransport } = require('./transport-registry');
const { createRelaySessionRegistry } = require('./relay-session-registry');

const RELAY_NODE_PATH = '/v0/relay/node';
const DEFAULT_RELAY_TRANSPORT_SCORE = 55;
const DEFAULT_RELAY_REQUEST_TIMEOUT_MS = 5000;
const DEFAULT_RELAY_STREAM_OPEN_TIMEOUT_MS = 5000;
const DEFAULT_RELAY_STREAM_WINDOW_SIZE = 16;
const MAX_RELAY_STREAM_WINDOW_SIZE = 128;
const sharedRelaySessionRegistry = createRelaySessionRegistry();

function createRelayRequestId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return crypto.randomBytes(12).toString('hex');
}

function writeUpgradeError(socket, statusCode, reason) {
  if (!socket || socket.destroyed) return;
  const statusText = {
    400: 'Bad Request',
    401: 'Unauthorized',
    404: 'Not Found',
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

function nodeIdFromRequest(req) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  return normalizeId(url.searchParams.get('nodeId') || req.headers['x-aih-node-id']);
}

function bearerFromRequest(req, deps = {}) {
  if (typeof deps.parseAuthorizationBearer === 'function') {
    return deps.parseAuthorizationBearer(req.headers.authorization);
  }
  const value = String(req.headers.authorization || '').trim();
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match ? String(match[1] || '').trim() : '';
}

function upsertRelayTransport(nodeId, patch = {}, deps = {}) {
  return upsertRemoteTransport({
    id: `${nodeId}-relay`,
    nodeId,
    kind: 'relay',
    endpoint: `relay://${nodeId}`,
    provider: 'aih-relay',
    managedBy: 'aih',
    routeRole: 'data-plane',
    trustLevel: 'managed',
    ...patch
  }, deps);
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

function parseJsonMessage(data) {
  try {
    return JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data || ''));
  } catch (_error) {
    return null;
  }
}

function createRelayRequestError(code, status = 502) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  return error;
}

function normalizeRelayStreamWindowSize(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return DEFAULT_RELAY_STREAM_WINDOW_SIZE;
  return Math.max(1, Math.min(MAX_RELAY_STREAM_WINDOW_SIZE, Math.floor(number)));
}

function buildRelayStreamWindow(value) {
  const credit = normalizeRelayStreamWindowSize(value);
  return { credit, max: credit };
}

function sendRelayStreamAck(socket, streamId, message, enabled) {
  if (!enabled) return;
  sendJson(socket, {
    type: 'relay.stream.ack',
    streamId,
    credit: 1,
    sequence: Number(message && message.sequence) || 0
  });
}

function parseRelayPath(value) {
  try {
    const url = new URL(String(value || ''), 'http://relay.local');
    return {
      pathname: url.pathname,
      search: url.search
    };
  } catch (_error) {
    return { pathname: '', search: '' };
  }
}

function isRelayManagementRequestAllowed(method, pathname) {
  const requestMethod = String(method || 'GET').toUpperCase();
  const parsed = parseRelayPath(pathname);
  if (requestMethod === 'POST') {
    return parsed.pathname === '/v0/node-rpc/session-input'
      || parsed.pathname === '/v0/node-rpc/session-start'
      || parsed.pathname === '/v0/node-rpc/session-attach'
      || parsed.pathname === '/v0/node-rpc/session-command'
      || parsed.pathname === '/v0/node-rpc/session-ack'
      || parsed.pathname === '/v0/node-rpc/session-run-input'
      || parsed.pathname === '/v0/node-rpc/session-run-abort';
  }
  if (requestMethod !== 'GET') return false;
  return parsed.pathname === '/v0/node-rpc/status'
    || parsed.pathname === '/v0/node-rpc/sessions'
    || parsed.pathname === '/v0/node-rpc/session-catalog'
    || parsed.pathname === '/v0/node-rpc/session-messages'
    || parsed.pathname === '/v0/node-rpc/session-run-events'
    || parsed.pathname.startsWith('/v0/management/');
}

function isRelayManagementStreamAllowed(method, pathname) {
  if (String(method || 'GET').toUpperCase() !== 'GET') return false;
  const parsed = parseRelayPath(pathname);
  return parsed.pathname === '/v0/node-rpc/session-stream';
}

function normalizeRelayRequestPath(pathname) {
  const parsed = parseRelayPath(pathname);
  if (!parsed.pathname) return '';
  return `${parsed.pathname}${parsed.search}`;
}

function waitForRelayResponse(socket, requestId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(createRelayRequestError('remote_relay_request_timeout', 504));
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
      if (!message || message.type !== 'relay.response' || message.requestId !== requestId) return;
      cleanup();
      resolve(message);
    }
    function onClose() {
      cleanup();
      reject(createRelayRequestError('remote_relay_session_closed', 503));
    }
    function onError() {
      cleanup();
      reject(createRelayRequestError('remote_relay_session_error', 503));
    }

    socket.on('message', onMessage);
    socket.once('close', onClose);
    socket.once('error', onError);
  });
}

async function requestRelayManagement(input = {}, deps = {}) {
  const node = input.node;
  const registry = deps.relaySessionRegistry || sharedRelaySessionRegistry;
  const session = registry.getRelaySession(node && node.id);
  const socket = session && session.socket;
  if (!session || !socket || socket.readyState !== 1) {
    throw createRelayRequestError('remote_relay_session_unavailable', 503);
  }

  const method = String(input.method || 'GET').toUpperCase();
  const pathname = normalizeRelayRequestPath(input.pathname || '/v0/management/status');
  if (!isRelayManagementRequestAllowed(method, pathname)) {
    throw createRelayRequestError('remote_relay_route_not_allowed', 403);
  }

  const requestId = createRelayRequestId();
  const timeoutMs = Math.max(1000, Number(input.timeoutMs || deps.timeoutMs) || DEFAULT_RELAY_REQUEST_TIMEOUT_MS);
  const responsePromise = waitForRelayResponse(socket, requestId, timeoutMs);
  if (!sendJson(socket, {
    type: 'relay.request',
    requestId,
    method,
    pathname,
    body: input.body
  })) {
    throw createRelayRequestError('remote_relay_send_failed', 503);
  }
  const response = await responsePromise;
  return {
    status: Number(response.status || 0),
    ok: Boolean(response.ok),
    payload: response.payload == null ? null : response.payload
  };
}

function waitForRelayStream(socket, streamId, handlers = {}, options = {}) {
  const signal = options.signal;
  const windowSize = normalizeRelayStreamWindowSize(options.windowSize);
  const windowEnabled = windowSize > 0;
  const openTimeoutMs = Math.max(
    1000,
    Number(options.openTimeoutMs || options.timeoutMs) || DEFAULT_RELAY_STREAM_OPEN_TIMEOUT_MS
  );
  return new Promise((resolve, reject) => {
    let opened = false;
    let settled = false;
    let pendingChunks = 0;
    let pendingEndMessage = null;
    const timer = setTimeout(() => {
      fail('remote_relay_stream_open_timeout', 504);
    }, openTimeoutMs);
    if (timer && typeof timer.unref === 'function') timer.unref();

    function cleanup() {
      clearTimeout(timer);
      socket.off('message', onMessage);
      socket.off('close', onClose);
      socket.off('error', onError);
      if (signal && typeof signal.removeEventListener === 'function') {
        signal.removeEventListener('abort', onAbort);
      }
    }
    function fail(code, status) {
      if (settled) return;
      settled = true;
      cleanup();
      reject(createRelayRequestError(code, status || 502));
    }
    function resolveFinished(message) {
      if (settled) return;
      settled = true;
      cleanup();
      if (typeof handlers.onEnd === 'function') handlers.onEnd(message);
      resolve({
        ok: message.ok !== false,
        status: Number(message.status || 0),
        streamId
      });
    }
    function finish(message) {
      if (pendingChunks > 0) {
        pendingEndMessage = message;
        return;
      }
      resolveFinished(message);
    }
    function trackChunkHandler(message, task) {
      pendingChunks += 1;
      Promise.resolve(task)
        .then(() => sendRelayStreamAck(socket, streamId, message, windowEnabled))
        .catch(() => fail('remote_relay_stream_chunk_handler_failed', 502))
        .finally(() => {
          pendingChunks = Math.max(0, pendingChunks - 1);
          if (pendingEndMessage && pendingChunks === 0) {
            resolveFinished(pendingEndMessage);
          }
        });
    }
    function onMessage(data) {
      const message = parseJsonMessage(data);
      if (!message || message.streamId !== streamId) return;
      if (message.type === 'relay.stream.opened') {
        opened = true;
        clearTimeout(timer);
        if (typeof handlers.onOpen === 'function') handlers.onOpen(message);
        if (message.ok === false) {
          fail(String(message.error || 'remote_relay_stream_open_failed'), Number(message.status || 502));
        }
        return;
      }
      if (message.type === 'relay.stream.chunk') {
        if (pendingEndMessage) return;
        if (!opened && typeof handlers.onOpen === 'function') {
          handlers.onOpen({ type: 'relay.stream.opened', streamId, ok: true, status: 200 });
        }
        opened = true;
        clearTimeout(timer);
        trackChunkHandler(
          message,
          typeof handlers.onChunk === 'function' ? handlers.onChunk(message.payload, message) : undefined
        );
        return;
      }
      if (message.type === 'relay.stream.end') {
        finish(message);
        return;
      }
      if (message.type === 'relay.stream.error') {
        fail(String(message.error || 'remote_relay_stream_error'), Number(message.status || 502));
      }
    }
    function onClose() {
      fail('remote_relay_session_closed', 503);
    }
    function onError() {
      fail('remote_relay_session_error', 503);
    }
    function onAbort() {
      sendJson(socket, { type: 'relay.stream.close', streamId });
      fail('remote_relay_stream_aborted', 499);
    }

    socket.on('message', onMessage);
    socket.once('close', onClose);
    socket.once('error', onError);
    if (signal && typeof signal.addEventListener === 'function') {
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }
  });
}

async function requestRelayManagementStream(input = {}, handlers = {}, deps = {}) {
  const node = input.node;
  const registry = deps.relaySessionRegistry || sharedRelaySessionRegistry;
  const session = registry.getRelaySession(node && node.id);
  const socket = session && session.socket;
  if (!session || !socket || socket.readyState !== 1) {
    throw createRelayRequestError('remote_relay_session_unavailable', 503);
  }

  const method = String(input.method || 'GET').toUpperCase();
  const pathname = normalizeRelayRequestPath(input.pathname || '/v0/node-rpc/session-stream');
  if (!isRelayManagementStreamAllowed(method, pathname)) {
    throw createRelayRequestError('remote_relay_stream_route_not_allowed', 403);
  }

  const streamId = createRelayRequestId();
  const windowSize = normalizeRelayStreamWindowSize(input.windowSize || deps.streamWindowSize);
  if (!sendJson(socket, {
    type: 'relay.stream.open',
    streamId,
    method,
    pathname,
    window: buildRelayStreamWindow(windowSize)
  })) {
    throw createRelayRequestError('remote_relay_stream_send_failed', 503);
  }
  return waitForRelayStream(socket, streamId, handlers, {
    signal: input.signal,
    openTimeoutMs: input.openTimeoutMs || deps.openTimeoutMs,
    windowSize
  });
}

function attachRelayHeartbeat(session, registry) {
  const socket = session.socket;
  if (!socket || typeof socket.on !== 'function') return;
  socket.on('message', (data) => {
    const message = parseJsonMessage(data);
    if (!message || typeof message !== 'object') return;
    if (message.type === 'relay.ping' || message.type === 'relay.heartbeat') {
      const touched = registry.touchRelaySession(session.sessionId);
      sendJson(socket, {
        type: 'relay.pong',
        ok: true,
        nodeId: session.nodeId,
        sessionId: session.sessionId,
        serverTime: touched ? touched.lastSeenAt : Date.now()
      });
    }
  });
}

function authorizeRelayNode(req, deps = {}) {
  const nodeId = nodeIdFromRequest(req);
  if (!nodeId) {
    return { ok: false, statusCode: 400, error: 'missing_relay_node_id' };
  }
  const node = getRemoteNode(nodeId, deps);
  if (!node || node.disabled) {
    return { ok: false, statusCode: 404, error: 'relay_node_not_found' };
  }
  const secret = readRemoteSecret(node.authRef, deps) || {};
  const expected = String(secret.managementKey || '').trim();
  const incoming = bearerFromRequest(req, deps);
  if (!expected || incoming !== expected) {
    return { ok: false, statusCode: 401, error: 'unauthorized_relay_node' };
  }
  return { ok: true, node };
}

function handleRelayNodeUpgrade(input = {}) {
  const { req, socket, head } = input;
  const deps = input.deps || {};
  const WebSocket = deps.WebSocket;
  if (!WebSocket || !WebSocket.Server) {
    writeUpgradeError(socket, 500, 'websocket_unavailable');
    return true;
  }

  const authorization = authorizeRelayNode(req, deps);
  if (!authorization.ok) {
    writeUpgradeError(socket, authorization.statusCode, authorization.error);
    return true;
  }

  const node = authorization.node;
  const registry = deps.relaySessionRegistry || sharedRelaySessionRegistry;
  const transport = upsertRelayTransport(node.id, {
    status: 'up',
    score: DEFAULT_RELAY_TRANSPORT_SCORE,
    latencyMs: 0,
    lastError: ''
  }, deps);
  const wss = new WebSocket.Server({ noServer: true });
  wss.handleUpgrade(req, socket, head, (client) => {
    const session = registry.registerRelaySession({
      nodeId: node.id,
      transportId: transport.id,
      socket: client,
      remoteAddress: String(deps.clientIp || (req.socket && req.socket.remoteAddress) || '').trim()
    });

    const markDisconnected = (errorCode) => {
      const current = registry.getRelaySession(node.id);
      if (!current || current.sessionId !== session.sessionId) return;
      registry.removeRelaySession(session.sessionId);
      upsertRelayTransport(node.id, {
        status: 'degraded',
        score: 0,
        latencyMs: 0,
        lastError: errorCode || 'relay_disconnected'
      }, deps);
    };

    attachRelayHeartbeat(session, registry);
    client.on('close', () => markDisconnected('relay_disconnected'));
    client.on('error', () => markDisconnected('relay_socket_error'));
    sendJson(client, {
      type: 'relay.hello',
      ok: true,
      nodeId: node.id,
      sessionId: session.sessionId,
      transportId: transport.id,
      serverTime: Date.now()
    });
  });
  return true;
}

module.exports = {
  RELAY_NODE_PATH,
  DEFAULT_RELAY_TRANSPORT_SCORE,
  DEFAULT_RELAY_REQUEST_TIMEOUT_MS,
  DEFAULT_RELAY_STREAM_OPEN_TIMEOUT_MS,
  DEFAULT_RELAY_STREAM_WINDOW_SIZE,
  MAX_RELAY_STREAM_WINDOW_SIZE,
  authorizeRelayNode,
  handleRelayNodeUpgrade,
  requestRelayManagement,
  requestRelayManagementStream,
  upsertRelayTransport
};
