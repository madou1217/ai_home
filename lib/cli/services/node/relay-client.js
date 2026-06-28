'use strict';

const { normalizeId } = require('../../../server/remote/node-registry');
const { buildServerUrl } = require('../../../server/server-defaults');
const {
  consumeSseJsonStream,
  isAbortError
} = require('../../../server/sse-json-stream');

const DEFAULT_HEARTBEAT_MS = 25000;
const DEFAULT_CONNECT_TIMEOUT_MS = 10000;
const DEFAULT_RECONNECT_DELAY_MS = 3000;
const MIN_HEARTBEAT_MS = 1000;
const MAX_HEARTBEAT_MS = 5 * 60 * 1000;
const MAX_RELAY_STREAM_WINDOW_SIZE = 128;

function isFlag(value) {
  return String(value || '').startsWith('-');
}

function readOptionValue(args, index, flag) {
  const token = String(args[index] || '');
  const prefix = `${flag}=`;
  if (token.startsWith(prefix)) {
    return { value: token.slice(prefix.length), consumed: 1 };
  }
  const value = args[index + 1];
  if (value === undefined || isFlag(value)) {
    const error = new Error(`missing_value:${flag}`);
    error.code = 'missing_option_value';
    error.flag = flag;
    throw error;
  }
  return { value: String(value), consumed: 2 };
}

function parsePositiveInteger(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function parseNodeRelayConnectArgs(rawArgs = []) {
  const args = Array.isArray(rawArgs) ? rawArgs.map((item) => String(item)) : [];
  const options = {
    controlUrl: '',
    nodeId: '',
    managementKey: '',
    heartbeatMs: DEFAULT_HEARTBEAT_MS,
    connectTimeoutMs: DEFAULT_CONNECT_TIMEOUT_MS,
    reconnectDelayMs: DEFAULT_RECONNECT_DELAY_MS,
    maxAttempts: 0,
    once: false,
    json: false
  };

  for (let index = 0; index < args.length;) {
    const token = String(args[index] || '').trim();
    if (!token) {
      index += 1;
      continue;
    }
    if (token === '--once') {
      options.once = true;
      index += 1;
      continue;
    }
    if (token === '--json') {
      options.json = true;
      index += 1;
      continue;
    }
    if (token === '--node-id' || token.startsWith('--node-id=')
      || token === '--id' || token.startsWith('--id=')) {
      const flag = token.startsWith('--id') ? '--id' : '--node-id';
      const next = readOptionValue(args, index, flag);
      options.nodeId = next.value;
      index += next.consumed;
      continue;
    }
    if (token === '--management-key' || token.startsWith('--management-key=')) {
      const next = readOptionValue(args, index, '--management-key');
      options.managementKey = next.value;
      index += next.consumed;
      continue;
    }
    if (token === '--heartbeat-ms' || token.startsWith('--heartbeat-ms=')) {
      const next = readOptionValue(args, index, '--heartbeat-ms');
      options.heartbeatMs = parsePositiveInteger(next.value, DEFAULT_HEARTBEAT_MS, MIN_HEARTBEAT_MS, MAX_HEARTBEAT_MS);
      index += next.consumed;
      continue;
    }
    if (token === '--connect-timeout-ms' || token.startsWith('--connect-timeout-ms=')) {
      const next = readOptionValue(args, index, '--connect-timeout-ms');
      options.connectTimeoutMs = parsePositiveInteger(next.value, DEFAULT_CONNECT_TIMEOUT_MS, 1000, 120000);
      index += next.consumed;
      continue;
    }
    if (token === '--reconnect-delay-ms' || token.startsWith('--reconnect-delay-ms=')) {
      const next = readOptionValue(args, index, '--reconnect-delay-ms');
      options.reconnectDelayMs = parsePositiveInteger(next.value, DEFAULT_RECONNECT_DELAY_MS, 250, 120000);
      index += next.consumed;
      continue;
    }
    if (token === '--max-attempts' || token.startsWith('--max-attempts=')) {
      const next = readOptionValue(args, index, '--max-attempts');
      options.maxAttempts = parsePositiveInteger(next.value, 0, 0, 1000000);
      index += next.consumed;
      continue;
    }
    if (isFlag(token)) {
      const error = new Error(`unknown_option:${token}`);
      error.code = 'unknown_option';
      error.flag = token;
      throw error;
    }
    if (options.controlUrl) {
      const error = new Error('too_many_relay_urls');
      error.code = 'too_many_relay_urls';
      throw error;
    }
    options.controlUrl = token;
    index += 1;
  }

  return options;
}

function readServerConfigSafe(readServerConfig) {
  if (typeof readServerConfig !== 'function') return {};
  try {
    return readServerConfig() || {};
  } catch (_error) {
    return {};
  }
}

function normalizeRelayUrl(controlUrl, nodeIdInput) {
  const raw = String(controlUrl || '').trim();
  if (!raw) {
    const error = new Error('missing_relay_url');
    error.code = 'missing_relay_url';
    throw error;
  }

  let url;
  try {
    url = new URL(raw);
  } catch (_error) {
    const error = new Error('invalid_relay_url');
    error.code = 'invalid_relay_url';
    throw error;
  }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) {
    const error = new Error('invalid_relay_url');
    error.code = 'invalid_relay_url';
    throw error;
  }

  const nodeId = normalizeId(nodeIdInput || url.searchParams.get('nodeId'));
  if (!nodeId) {
    const error = new Error('missing_relay_node_id');
    error.code = 'missing_relay_node_id';
    throw error;
  }

  url.protocol = url.protocol === 'http:' || url.protocol === 'ws:' ? 'ws:' : 'wss:';
  url.pathname = '/v0/relay/node';
  url.search = '';
  url.searchParams.set('nodeId', nodeId);
  return { url, nodeId };
}

function resolveRelayManagementKey(options, serverConfig) {
  const key = String(options.managementKey || serverConfig.managementKey || '').trim();
  if (!key) {
    const error = new Error('management_key_required');
    error.code = 'management_key_required';
    error.command = 'relay-connect';
    throw error;
  }
  return key;
}

function getWebSocketClass(deps = {}) {
  if (deps.WebSocket) return deps.WebSocket;
  return require('ws');
}

function createRelaySocket(WebSocketClass, url, managementKey) {
  return new WebSocketClass(url.toString(), {
    headers: {
      authorization: `Bearer ${managementKey}`
    }
  });
}

function withTimeout(promise, timeoutMs, code) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        const error = new Error(code);
        error.code = code;
        reject(error);
      }, timeoutMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
    })
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function parseJsonMessage(data) {
  try {
    return JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data || ''));
  } catch (_error) {
    return null;
  }
}

function normalizeRelayWindowCount(value, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.max(1, Math.min(MAX_RELAY_STREAM_WINDOW_SIZE, Math.floor(number)));
}

function parseRelayRequestPath(value) {
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

function isRelayLocalRequestAllowed(method, pathname) {
  const requestMethod = String(method || 'GET').toUpperCase();
  const parsed = parseRelayRequestPath(pathname);
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
    || parsed.pathname === '/v0/node-rpc/session-artifact'
    || parsed.pathname.startsWith('/v0/management/');
}

function isRelayLocalStreamAllowed(method, pathname) {
  if (String(method || 'GET').toUpperCase() !== 'GET') return false;
  const parsed = parseRelayRequestPath(pathname);
  return parsed.pathname === '/v0/node-rpc/session-stream';
}

function normalizeRelayLocalPath(pathname) {
  const parsed = parseRelayRequestPath(pathname);
  if (!parsed.pathname) return '';
  return `${parsed.pathname}${parsed.search}`;
}

function buildLocalRelayUrl(localBaseUrl, pathname) {
  const base = String(localBaseUrl || '').trim().replace(/\/+$/, '');
  const path = normalizeRelayLocalPath(pathname);
  return base && path ? `${base}${path}` : '';
}

function createRelayStreamFlowControl(frame = {}) {
  const windowFrame = frame.window && typeof frame.window === 'object' ? frame.window : {};
  const initialCredit = normalizeRelayWindowCount(windowFrame.credit || windowFrame.initial || windowFrame.size, 0);
  const maxCredit = normalizeRelayWindowCount(windowFrame.max, initialCredit || MAX_RELAY_STREAM_WINDOW_SIZE);
  const enabled = initialCredit > 0;
  let credit = enabled ? Math.min(initialCredit, maxCredit) : 0;
  let closed = false;
  const waiters = [];

  function flush() {
    while (!closed && credit > 0 && waiters.length > 0) {
      credit -= 1;
      waiters.shift().resolve();
    }
  }

  function waitForCredit() {
    if (!enabled) return Promise.resolve();
    if (closed) {
      const error = new Error('relay_stream_closed');
      error.code = 'relay_stream_closed';
      return Promise.reject(error);
    }
    if (credit > 0) {
      credit -= 1;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      waiters.push({ resolve, reject });
    });
  }

  function addCredit(value) {
    if (!enabled || closed) return;
    const count = normalizeRelayWindowCount(value, 1);
    credit = Math.min(maxCredit, credit + count);
    flush();
  }

  function close() {
    if (closed) return;
    closed = true;
    const error = new Error('relay_stream_closed');
    error.code = 'relay_stream_closed';
    while (waiters.length > 0) {
      waiters.shift().reject(error);
    }
  }

  return {
    addCredit,
    close,
    waitForCredit
  };
}

async function readRelayFetchPayload(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch (_error) {
    return { ok: false, raw: text };
  }
}

async function fetchLocalRelayRequest(frame, request, deps = {}) {
  const method = String(frame.method || 'GET').toUpperCase();
  const pathname = normalizeRelayLocalPath(frame.pathname);
  if (!isRelayLocalRequestAllowed(method, pathname)) {
    return {
      status: 403,
      ok: false,
      payload: { ok: false, error: 'relay_local_route_not_allowed' }
    };
  }
  const url = buildLocalRelayUrl(request.localBaseUrl, pathname);
  const fetchFn = deps.fetchImpl || globalThis.fetch;
  if (!url || typeof fetchFn !== 'function') {
    return {
      status: 500,
      ok: false,
      payload: { ok: false, error: 'relay_local_fetch_unavailable' }
    };
  }
  const response = await fetchFn(url, {
    method,
    headers: {
      authorization: `Bearer ${request.managementKey}`,
      ...(frame.body !== undefined ? { 'content-type': 'application/json' } : {})
    },
    body: frame.body === undefined ? undefined : String(frame.body)
  });
  return {
    status: Number(response.status || 0),
    ok: Boolean(response.ok),
    payload: await readRelayFetchPayload(response)
  };
}

async function respondToRelayRequest(socket, frame, request, deps = {}) {
  let result = null;
  try {
    result = await fetchLocalRelayRequest(frame, request, deps);
  } catch (_error) {
    result = {
      status: 502,
      ok: false,
      payload: { ok: false, error: 'relay_local_request_failed' }
    };
  }
  sendRelayJson(socket, {
    type: 'relay.response',
    requestId: String(frame.requestId || ''),
    status: result.status,
    ok: result.ok,
    payload: result.payload
  });
}

function sendRelayStreamError(socket, streamId, error, status = 502) {
  sendRelayJson(socket, {
    type: 'relay.stream.error',
    streamId,
    status,
    error
  });
}

async function handleRelayStreamOpen(socket, frame, request, streamsById, deps = {}) {
  const streamId = String(frame.streamId || '').trim();
  if (!streamId) return;
  const method = String(frame.method || 'GET').toUpperCase();
  const pathname = normalizeRelayLocalPath(frame.pathname);
  if (!isRelayLocalStreamAllowed(method, pathname)) {
    sendRelayStreamError(socket, streamId, 'relay_local_stream_route_not_allowed', 403);
    return;
  }

  const url = buildLocalRelayUrl(request.localBaseUrl, pathname);
  const fetchFn = deps.fetchImpl || globalThis.fetch;
  if (!url || typeof fetchFn !== 'function') {
    sendRelayStreamError(socket, streamId, 'relay_local_fetch_unavailable', 500);
    return;
  }

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const streamState = {
    controller,
    flow: createRelayStreamFlowControl(frame),
    sequence: 0
  };
  streamsById.set(streamId, streamState);
  try {
    const response = await fetchFn(url, {
      method,
      headers: {
        authorization: `Bearer ${request.managementKey}`
      },
      signal: controller && controller.signal
    });
    sendRelayJson(socket, {
      type: 'relay.stream.opened',
      streamId,
      status: Number(response.status || 0),
      ok: Boolean(response.ok)
    });
    if (!response.ok) {
      sendRelayJson(socket, {
        type: 'relay.stream.end',
        streamId,
        status: Number(response.status || 0),
        ok: false
      });
      return;
    }
    await consumeSseJsonStream(response, async (payload) => {
      await streamState.flow.waitForCredit();
      streamState.sequence += 1;
      if (!sendRelayJson(socket, {
        type: 'relay.stream.chunk',
        streamId,
        sequence: streamState.sequence,
        payload
      })) {
        const error = new Error('relay_socket_send_failed');
        error.code = 'relay_socket_send_failed';
        throw error;
      }
    }, {
      signal: controller && controller.signal
    });
    sendRelayJson(socket, {
      type: 'relay.stream.end',
      streamId,
      status: Number(response.status || 0),
      ok: true
    });
  } catch (error) {
    if (isAbortError(error)) {
      sendRelayJson(socket, {
        type: 'relay.stream.end',
        streamId,
        status: 499,
        ok: false,
        error: 'relay_local_stream_closed'
      });
      return;
    }
    sendRelayStreamError(socket, streamId, 'relay_local_stream_failed', 502);
  } finally {
    streamState.flow.close();
    streamsById.delete(streamId);
  }
}

function closeRelayStreams(streamsById) {
  for (const streamState of streamsById.values()) {
    if (streamState && streamState.flow) streamState.flow.close();
    const controller = streamState && streamState.controller;
    if (controller && typeof controller.abort === 'function') {
      try {
        controller.abort();
      } catch (_error) {}
    }
  }
}

function attachRelayRequestHandler(socket, request, deps = {}) {
  const streamsById = new Map();
  socket.on('message', (data) => {
    const frame = parseJsonMessage(data);
    if (!frame) return;
    if (frame.type === 'relay.request' && frame.requestId) {
      respondToRelayRequest(socket, frame, request, deps);
      return;
    }
    if (frame.type === 'relay.stream.open') {
      handleRelayStreamOpen(socket, frame, request, streamsById, deps);
      return;
    }
    if (frame.type === 'relay.stream.close') {
      const streamState = streamsById.get(String(frame.streamId || '').trim());
      if (streamState && streamState.flow) streamState.flow.close();
      const controller = streamState && streamState.controller;
      if (controller && typeof controller.abort === 'function') controller.abort();
      return;
    }
    if (frame.type === 'relay.stream.ack') {
      const streamState = streamsById.get(String(frame.streamId || '').trim());
      if (streamState && streamState.flow) streamState.flow.addCredit(frame.credit);
    }
  });
  socket.on('close', () => closeRelayStreams(streamsById));
  socket.on('error', () => closeRelayStreams(streamsById));
}

function waitForOpen(socket) {
  return new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('unexpected-response', (_request, response) => {
      const error = new Error(`relay_http_${response.statusCode}`);
      error.code = 'relay_upgrade_rejected';
      error.statusCode = response.statusCode;
      reject(error);
    });
    socket.once('error', reject);
  });
}

function waitForMessageType(socket, type) {
  return new Promise((resolve, reject) => {
    function onMessage(data) {
      const message = parseJsonMessage(data);
      if (!message || message.type !== type) return;
      cleanup();
      resolve(message);
    }
    function onError(error) {
      cleanup();
      reject(error);
    }
    function onClose() {
      cleanup();
      const error = new Error('relay_socket_closed');
      error.code = 'relay_socket_closed';
      reject(error);
    }
    function cleanup() {
      socket.off('message', onMessage);
      socket.off('error', onError);
      socket.off('close', onClose);
    }
    socket.on('message', onMessage);
    socket.once('error', onError);
    socket.once('close', onClose);
  });
}

function sendRelayJson(socket, payload) {
  if (!socket || socket.readyState !== 1) return false;
  socket.send(JSON.stringify(payload));
  return true;
}

function closeRelaySocket(socket) {
  if (!socket || socket.readyState === 2 || socket.readyState === 3) return;
  try {
    socket.close();
  } catch (_error) {}
}

async function connectRelayOnce(request, deps = {}) {
  const WebSocketClass = getWebSocketClass(deps);
  const socket = createRelaySocket(WebSocketClass, request.url, request.managementKey);
  const helloPromise = waitForMessageType(socket, 'relay.hello');
  helloPromise.catch(() => {});
  await withTimeout(waitForOpen(socket), request.connectTimeoutMs, 'relay_connect_timeout');
  const hello = await withTimeout(helloPromise, request.connectTimeoutMs, 'relay_hello_timeout');
  attachRelayRequestHandler(socket, request, deps);
  if (request.once) {
    sendRelayJson(socket, { type: 'relay.ping' });
    await withTimeout(waitForMessageType(socket, 'relay.pong'), request.connectTimeoutMs, 'relay_pong_timeout');
    closeRelaySocket(socket);
  }
  return { socket, hello };
}

function waitForClose(socket) {
  return new Promise((resolve) => {
    socket.once('close', () => resolve());
    socket.once('error', () => resolve());
  });
}

function startHeartbeat(socket, heartbeatMs) {
  const timer = setInterval(() => {
    sendRelayJson(socket, { type: 'relay.heartbeat' });
  }, heartbeatMs);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearInterval(timer);
}

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
}

function buildRelayRequest(options, deps = {}) {
  const serverConfig = readServerConfigSafe(deps.readServerConfig);
  const normalized = normalizeRelayUrl(options.controlUrl, options.nodeId);
  return {
    url: normalized.url,
    nodeId: normalized.nodeId,
    managementKey: resolveRelayManagementKey(options, serverConfig),
    localBaseUrl: buildServerUrl(serverConfig, ''),
    heartbeatMs: options.heartbeatMs,
    connectTimeoutMs: options.connectTimeoutMs,
    reconnectDelayMs: options.reconnectDelayMs,
    maxAttempts: options.maxAttempts,
    once: Boolean(options.once)
  };
}

function serializeRelayConnection(request, hello, attempts) {
  return {
    ok: true,
    nodeId: request.nodeId,
    relayUrl: request.url.toString(),
    sessionId: String(hello && hello.sessionId || ''),
    transportId: String(hello && hello.transportId || ''),
    attempts
  };
}

async function runRelayLoop(request, deps = {}) {
  let attempts = 0;
  let lastResult = null;
  while (!request.maxAttempts || attempts < request.maxAttempts) {
    attempts += 1;
    const connection = await connectRelayOnce(request, deps);
    const stopHeartbeat = startHeartbeat(connection.socket, request.heartbeatMs);
    lastResult = serializeRelayConnection(request, connection.hello, attempts);
    await waitForClose(connection.socket);
    stopHeartbeat();
    if (request.maxAttempts && attempts >= request.maxAttempts) break;
    await sleep(request.reconnectDelayMs);
  }
  return lastResult || {
    ok: false,
    nodeId: request.nodeId,
    relayUrl: request.url.toString(),
    sessionId: '',
    transportId: '',
    attempts
  };
}

async function runNodeRelayConnect(rawArgs = [], deps = {}) {
  const options = parseNodeRelayConnectArgs(rawArgs);
  const request = buildRelayRequest(options, deps);
  if (request.once) {
    const connection = await connectRelayOnce(request, deps);
    return {
      ...serializeRelayConnection(request, connection.hello, 1),
      json: Boolean(options.json),
      once: true
    };
  }
  const result = await runRelayLoop(request, deps);
  return {
    ...result,
    json: Boolean(options.json),
    once: false
  };
}

module.exports = {
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_RECONNECT_DELAY_MS,
  parseNodeRelayConnectArgs,
  normalizeRelayUrl,
  buildRelayRequest,
  consumeSseJsonStream,
  fetchLocalRelayRequest,
  runNodeRelayConnect
};
