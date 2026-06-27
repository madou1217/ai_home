'use strict';

const {
  isFlag,
  nonEmptyString,
  normalizePositiveInteger,
  readOptionValue
} = require('./option-parser');
const {
  FABRIC_BROKER_CONTROL_PATH,
  DEFAULT_BROKER_REQUEST_TIMEOUT_MS,
  isFabricBrokerRouteAllowed,
  pickForwardHeaders,
  pickResponseHeaders
} = require('../../../server/fabric-broker-router');
const { normalizeFabricServerId } = require('../../../server/fabric-broker-session-registry');

const DEFAULT_LOCAL_SERVER_URL = 'http://127.0.0.1:9527';
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_BROKER_HEARTBEAT_MS = 25_000;
const DEFAULT_BROKER_RECONNECT_DELAY_MS = 3000;

function parseFabricBrokerConnectArgs(rawArgs = [], deps = {}) {
  const args = Array.isArray(rawArgs) ? rawArgs.map((item) => String(item)) : [];
  const env = deps.env || process.env || {};
  const options = {
    brokerUrl: '',
    serverId: '',
    token: nonEmptyString(env.AIH_FABRIC_BROKER_TOKEN),
    localUrl: nonEmptyString(env.AIH_FABRIC_LOCAL_URL) || DEFAULT_LOCAL_SERVER_URL,
    connectTimeoutMs: DEFAULT_CONNECT_TIMEOUT_MS,
    requestTimeoutMs: DEFAULT_BROKER_REQUEST_TIMEOUT_MS,
    heartbeatMs: DEFAULT_BROKER_HEARTBEAT_MS,
    reconnectDelayMs: DEFAULT_BROKER_RECONNECT_DELAY_MS,
    maxAttempts: 0,
    once: false,
    json: false
  };

  for (let index = 0; index < args.length;) {
    const token = nonEmptyString(args[index]);
    if (!token) {
      index += 1;
      continue;
    }
    if (token === '--json') {
      options.json = true;
      index += 1;
      continue;
    }
    if (token === '--once') {
      options.once = true;
      index += 1;
      continue;
    }
    if (token === '--server-id' || token.startsWith('--server-id=')) {
      const next = readOptionValue(args, index, '--server-id');
      options.serverId = normalizeFabricServerId(next.value);
      index += next.consumed;
      continue;
    }
    if (token === '--token' || token.startsWith('--token=')) {
      const next = readOptionValue(args, index, '--token');
      options.token = nonEmptyString(next.value);
      index += next.consumed;
      continue;
    }
    if (token === '--local-url' || token.startsWith('--local-url=')) {
      const next = readOptionValue(args, index, '--local-url');
      options.localUrl = normalizeHttpUrl(next.value, 'invalid_fabric_broker_local_url');
      index += next.consumed;
      continue;
    }
    if (token === '--connect-timeout-ms' || token.startsWith('--connect-timeout-ms=')) {
      const next = readOptionValue(args, index, '--connect-timeout-ms');
      options.connectTimeoutMs = normalizePositiveInteger(next.value, DEFAULT_CONNECT_TIMEOUT_MS, 1000, 120000);
      index += next.consumed;
      continue;
    }
    if (token === '--request-timeout-ms' || token.startsWith('--request-timeout-ms=')) {
      const next = readOptionValue(args, index, '--request-timeout-ms');
      options.requestTimeoutMs = normalizePositiveInteger(next.value, DEFAULT_BROKER_REQUEST_TIMEOUT_MS, 1000, 120000);
      index += next.consumed;
      continue;
    }
    if (token === '--heartbeat-ms' || token.startsWith('--heartbeat-ms=')) {
      const next = readOptionValue(args, index, '--heartbeat-ms');
      options.heartbeatMs = normalizePositiveInteger(next.value, DEFAULT_BROKER_HEARTBEAT_MS, 1000, 300000);
      index += next.consumed;
      continue;
    }
    if (token === '--reconnect-delay-ms' || token.startsWith('--reconnect-delay-ms=')) {
      const next = readOptionValue(args, index, '--reconnect-delay-ms');
      options.reconnectDelayMs = normalizePositiveInteger(next.value, DEFAULT_BROKER_RECONNECT_DELAY_MS, 250, 120000);
      index += next.consumed;
      continue;
    }
    if (token === '--max-attempts' || token.startsWith('--max-attempts=')) {
      const next = readOptionValue(args, index, '--max-attempts');
      options.maxAttempts = normalizePositiveInteger(next.value, 0, 0, 1000000);
      index += next.consumed;
      continue;
    }
    if (isFlag(token)) {
      const error = new Error(`unknown_option:${token}`);
      error.code = 'unknown_option';
      error.flag = token;
      throw error;
    }
    if (options.brokerUrl) {
      const error = new Error('too_many_fabric_broker_urls');
      error.code = 'too_many_fabric_broker_urls';
      throw error;
    }
    options.brokerUrl = normalizeBrokerUrl(token);
    index += 1;
  }

  if (!options.brokerUrl) {
    const error = new Error('missing_fabric_broker_url');
    error.code = 'missing_fabric_broker_url';
    throw error;
  }
  if (!options.serverId) {
    const error = new Error('missing_fabric_broker_server_id');
    error.code = 'missing_fabric_broker_server_id';
    throw error;
  }
  if (!options.token) {
    const error = new Error('missing_fabric_broker_token');
    error.code = 'missing_fabric_broker_token';
    throw error;
  }
  options.localUrl = normalizeHttpUrl(options.localUrl, 'invalid_fabric_broker_local_url');
  return options;
}

function normalizeHttpUrl(value, code) {
  const raw = nonEmptyString(value).replace(/\/+$/, '');
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('bad_protocol');
    url.hash = '';
    return url.toString().replace(/\/+$/, '');
  } catch (_error) {
    const error = new Error(code || 'invalid_http_url');
    error.code = code || 'invalid_http_url';
    error.endpoint = raw;
    throw error;
  }
}

function normalizeBrokerUrl(value) {
  const raw = nonEmptyString(value).replace(/\/+$/, '');
  try {
    const url = new URL(raw);
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) throw new Error('bad_protocol');
    url.protocol = url.protocol === 'https:' || url.protocol === 'wss:' ? 'wss:' : 'ws:';
    url.pathname = FABRIC_BROKER_CONTROL_PATH;
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch (_error) {
    const error = new Error('invalid_fabric_broker_url');
    error.code = 'invalid_fabric_broker_url';
    error.endpoint = raw;
    throw error;
  }
}

function buildBrokerSocketUrl(options) {
  const url = new URL(normalizeBrokerUrl(options.brokerUrl));
  url.searchParams.set('serverId', options.serverId);
  return url;
}

function waitForOpen(socket) {
  return new Promise((resolve, reject) => {
    function cleanup() {
      socket.off('open', onOpen);
      socket.off('error', onError);
      socket.off('close', onClose);
    }
    function onOpen() {
      cleanup();
      resolve();
    }
    function onError(error) {
      cleanup();
      reject(error);
    }
    function onClose() {
      cleanup();
      const error = new Error('fabric_broker_socket_closed');
      error.code = 'fabric_broker_socket_closed';
      reject(error);
    }
    socket.once('open', onOpen);
    socket.once('error', onError);
    socket.once('close', onClose);
  });
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

function normalizeSocketCloseReason(value) {
  return String(Buffer.isBuffer(value) ? value.toString('utf8') : value || '').trim().slice(0, 256);
}

function serializeBrokerConnection(handle, attempts, mode) {
  return {
    ok: true,
    json: false,
    serverId: handle.serverId,
    brokerUrl: handle.brokerUrl,
    localUrl: handle.localUrl,
    sessionId: handle.sessionId,
    mode,
    attempts,
    connectedAt: handle.diagnostics ? handle.diagnostics.connectedAt : 0,
    lastHeartbeatAt: handle.diagnostics ? handle.diagnostics.lastHeartbeatAt : 0,
    lastPongAt: handle.diagnostics ? handle.diagnostics.lastPongAt : 0
  };
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

function waitForHello(socket, serverId) {
  return new Promise((resolve, reject) => {
    function cleanup() {
      socket.off('message', onMessage);
      socket.off('close', onClose);
      socket.off('error', onError);
    }
    function onMessage(data) {
      const message = parseJsonMessage(data);
      if (!message || message.type !== 'broker.hello') return;
      cleanup();
      if (message.ok !== true || message.serverId !== serverId) {
        const error = new Error('fabric_broker_hello_rejected');
        error.code = 'fabric_broker_hello_rejected';
        reject(error);
        return;
      }
      resolve(message);
    }
    function onClose() {
      cleanup();
      const error = new Error('fabric_broker_socket_closed');
      error.code = 'fabric_broker_socket_closed';
      reject(error);
    }
    function onError(error) {
      cleanup();
      reject(error);
    }
    socket.on('message', onMessage);
    socket.once('close', onClose);
    socket.once('error', onError);
  });
}

function buildLocalRequestUrl(localUrl, pathname) {
  const parsed = new URL(String(pathname || '/'), 'http://broker.local');
  const base = new URL(`${String(localUrl || '').replace(/\/+$/, '')}/`);
  const local = new URL(parsed.pathname.replace(/^\/+/, ''), base);
  local.search = parsed.search;
  return local.toString();
}

async function handleBrokerRequestFrame(socket, frame = {}, options = {}, deps = {}) {
  const method = nonEmptyString(frame.method || 'GET').toUpperCase();
  const pathname = nonEmptyString(frame.pathname || '/');
  const requestId = nonEmptyString(frame.requestId);
  if (!requestId) return;
  if (!isFabricBrokerRouteAllowed(method, pathname)) {
    sendJson(socket, {
      type: 'broker.response',
      requestId,
      ok: false,
      status: 403,
      headers: { 'content-type': 'application/json' },
      bodyBase64: Buffer.from(JSON.stringify({ ok: false, error: 'fabric_broker_local_route_not_allowed' })).toString('base64')
    });
    return;
  }

  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    sendJson(socket, {
      type: 'broker.response',
      requestId,
      ok: false,
      status: 500,
      headers: { 'content-type': 'application/json' },
      bodyBase64: Buffer.from(JSON.stringify({ ok: false, error: 'fabric_broker_fetch_unavailable' })).toString('base64')
    });
    return;
  }

  try {
    const body = frame.bodyBase64 ? Buffer.from(String(frame.bodyBase64), 'base64') : undefined;
    const response = await withTimeout(fetchImpl(buildLocalRequestUrl(options.localUrl, pathname), {
      method,
      headers: pickForwardHeaders(frame.headers || {}),
      body: method === 'GET' || method === 'HEAD' ? undefined : body
    }), options.requestTimeoutMs, 'fabric_broker_local_request_timeout');
    const buffer = Buffer.from(await response.arrayBuffer());
    const headers = {};
    if (response.headers && typeof response.headers.forEach === 'function') {
      response.headers.forEach((value, name) => {
        headers[name.toLowerCase()] = value;
      });
    }
    sendJson(socket, {
      type: 'broker.response',
      requestId,
      ok: response.ok,
      status: response.status,
      headers: pickResponseHeaders(headers),
      bodyBase64: buffer.length > 0 ? buffer.toString('base64') : ''
    });
  } catch (error) {
    sendJson(socket, {
      type: 'broker.response',
      requestId,
      ok: false,
      status: 502,
      headers: { 'content-type': 'application/json' },
      bodyBase64: Buffer.from(JSON.stringify({
        ok: false,
        error: String((error && error.code) || 'fabric_broker_local_request_failed')
      })).toString('base64')
    });
  }
}

function getWebSocketClass(deps = {}) {
  if (deps.WebSocket) return deps.WebSocket;
  return require('ws');
}

async function connectFabricBroker(options = {}, deps = {}) {
  const WebSocketClass = getWebSocketClass(deps);
  const socket = new WebSocketClass(buildBrokerSocketUrl(options).toString(), {
    headers: {
      authorization: `Bearer ${options.token}`
    }
  });
  const helloPromise = waitForHello(socket, options.serverId);
  helloPromise.catch(() => {});
  await withTimeout(waitForOpen(socket), options.connectTimeoutMs, 'fabric_broker_connect_timeout');
  const hello = await withTimeout(helloPromise, options.connectTimeoutMs, 'fabric_broker_hello_timeout');
  const diagnostics = {
    connectedAt: Date.now(),
    lastHeartbeatAt: 0,
    lastPongAt: 0
  };

  const closed = new Promise((resolve) => {
    socket.once('close', (code, reason) => resolve({
      ok: true,
      reason: 'closed',
      code: Number(code) || 0,
      closeReason: normalizeSocketCloseReason(reason),
      connectedAt: diagnostics.connectedAt,
      lastHeartbeatAt: diagnostics.lastHeartbeatAt,
      lastPongAt: diagnostics.lastPongAt,
      disconnectedAt: Date.now()
    }));
    socket.once('error', (error) => resolve({
      ok: false,
      reason: 'error',
      error: String((error && error.message) || error || 'socket_error'),
      connectedAt: diagnostics.connectedAt,
      lastHeartbeatAt: diagnostics.lastHeartbeatAt,
      lastPongAt: diagnostics.lastPongAt,
      disconnectedAt: Date.now()
    }));
  });

  socket.on('message', (data) => {
    const frame = parseJsonMessage(data);
    if (frame && frame.type === 'broker.pong') {
      diagnostics.lastPongAt = Date.now();
      return;
    }
    if (!frame || frame.type !== 'broker.request') return;
    handleBrokerRequestFrame(socket, frame, options, deps);
  });

  const timer = setInterval(() => {
    diagnostics.lastHeartbeatAt = Date.now();
    sendJson(socket, { type: 'broker.heartbeat' });
  }, options.heartbeatMs);
  if (timer && typeof timer.unref === 'function') timer.unref();
  const closedWithCleanup = closed.finally(() => clearInterval(timer));

  return {
    ok: true,
    serverId: options.serverId,
    brokerUrl: options.brokerUrl,
    localUrl: options.localUrl,
    sessionId: hello.sessionId,
    diagnostics,
    socket,
    closed: closedWithCleanup,
    close() {
      clearInterval(timer);
      if (socket.readyState === 1 || socket.readyState === 0) socket.close();
    }
  };
}

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
}

async function runBrokerConnectLoop(options = {}, deps = {}) {
  const connect = deps.connectFabricBroker || connectFabricBroker;
  const wait = deps.sleep || sleep;
  let attempts = 0;
  let lastResult = null;
  while (!options.maxAttempts || attempts < options.maxAttempts) {
    attempts += 1;
    let handle = null;
    try {
      handle = await connect(options, deps);
    } catch (error) {
      if (attempts === 1) throw error;
      lastResult = {
        ok: false,
        json: options.json,
        serverId: options.serverId,
        brokerUrl: options.brokerUrl,
        localUrl: options.localUrl,
        sessionId: '',
        mode: 'foreground',
        attempts,
        reason: String((error && error.code) || 'fabric_broker_reconnect_failed'),
        error: String((error && error.message) || error || '')
      };
      if (options.maxAttempts && attempts >= options.maxAttempts) break;
      await wait(options.reconnectDelayMs);
      continue;
    }
    const closed = await handle.closed;
    lastResult = {
      ...serializeBrokerConnection(handle, attempts, 'foreground'),
      json: options.json,
      ok: closed.ok,
      reason: closed.reason,
      closeCode: closed.code || 0,
      closeReason: closed.closeReason || '',
      error: closed.error || '',
      disconnectedAt: closed.disconnectedAt || 0,
      connectedAt: closed.connectedAt || 0,
      lastHeartbeatAt: closed.lastHeartbeatAt || 0,
      lastPongAt: closed.lastPongAt || 0
    };
    if (options.maxAttempts && attempts >= options.maxAttempts) break;
    await wait(options.reconnectDelayMs);
  }
  return lastResult || {
    ok: false,
    json: options.json,
    serverId: options.serverId,
    brokerUrl: options.brokerUrl,
    localUrl: options.localUrl,
    sessionId: '',
    mode: 'foreground',
    attempts
  };
}

async function runFabricBrokerConnect(rawArgs = [], deps = {}) {
  const options = parseFabricBrokerConnectArgs(rawArgs, deps);
  const connect = deps.connectFabricBroker || connectFabricBroker;
  if (options.once) {
    const handle = await connect(options, deps);
    handle.close();
    return {
      ...serializeBrokerConnection(handle, 1, 'once'),
      json: options.json
    };
  }
  return runBrokerConnectLoop(options, deps);
}

function formatFabricBrokerConnectReport(result = {}) {
  return [
    'AIH Fabric broker connect',
    `  server: ${result.serverId || ''}`,
    `  broker: ${result.brokerUrl || ''}`,
    `  local: ${result.localUrl || ''}`,
    `  session: ${result.sessionId || ''}`,
    `  mode: ${result.mode || ''}`,
    `  attempts: ${Number(result.attempts) || 0}`,
    result.reason ? `  reason: ${result.reason}` : '',
    result.closeCode ? `  closeCode: ${result.closeCode}` : '',
    result.closeReason ? `  closeReason: ${result.closeReason}` : '',
    result.error ? `  error: ${result.error}` : ''
  ].filter(Boolean).join('\n');
}

module.exports = {
  DEFAULT_LOCAL_SERVER_URL,
  DEFAULT_BROKER_RECONNECT_DELAY_MS,
  buildBrokerSocketUrl,
  buildLocalRequestUrl,
  connectFabricBroker,
  formatFabricBrokerConnectReport,
  handleBrokerRequestFrame,
  normalizeBrokerUrl,
  parseFabricBrokerConnectArgs,
  runBrokerConnectLoop,
  runFabricBrokerConnect
};
