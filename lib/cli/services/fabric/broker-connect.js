'use strict';

const {
  isFlag,
  nonEmptyString,
  normalizePositiveInteger,
  readOptionValue
} = require('./option-parser');
const {
  FABRIC_BROKER_CONTROL_PATH,
  DEFAULT_BROKER_REQUEST_TIMEOUT_MS
} = require('../../../server/fabric-broker-router');
const { normalizeFabricServerId } = require('../../../server/fabric-broker-session-registry');
const {
  createBrokerRequestHandler,
  localRequestUrl: buildLocalRequestUrl
} = require('./broker-request-handler');
const { createBrokerWebSocketHandler } = require('./broker-websocket-handler');
const {
  DEFAULT_RECONNECT_DELAY_MS,
  DEFAULT_RECONNECT_JITTER_RATIO,
  DEFAULT_RECONNECT_MAX_DELAY_MS,
  calculateReconnectDelay
} = require('../../../runtime/reconnect-backoff');

const DEFAULT_LOCAL_SERVER_URL = 'http://127.0.0.1:9527';
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_BROKER_HEARTBEAT_MS = 25_000;
const DEFAULT_BROKER_RECONNECT_DELAY_MS = DEFAULT_RECONNECT_DELAY_MS;
const DEFAULT_BROKER_RECONNECT_MAX_DELAY_MS = DEFAULT_RECONNECT_MAX_DELAY_MS;
const DEFAULT_BROKER_RECONNECT_JITTER_RATIO = DEFAULT_RECONNECT_JITTER_RATIO;
const MAX_BROKER_ENDPOINTS = 5;

function parseFabricBrokerConnectArgs(rawArgs = [], deps = {}) {
  const args = Array.isArray(rawArgs) ? rawArgs.map((item) => String(item)) : [];
  const env = deps.env || process.env || {};
  const brokerUrls = [];
  const managementKeys = [];
  const options = {
    brokerUrl: '',
    serverId: '',
    managementKey: '',
    brokers: [],
    localUrl: nonEmptyString(env.AIH_FABRIC_LOCAL_URL) || DEFAULT_LOCAL_SERVER_URL,
    connectTimeoutMs: DEFAULT_CONNECT_TIMEOUT_MS,
    requestTimeoutMs: DEFAULT_BROKER_REQUEST_TIMEOUT_MS,
    heartbeatMs: DEFAULT_BROKER_HEARTBEAT_MS,
    reconnectDelayMs: DEFAULT_BROKER_RECONNECT_DELAY_MS,
    reconnectMaxDelayMs: DEFAULT_BROKER_RECONNECT_MAX_DELAY_MS,
    reconnectJitterRatio: DEFAULT_BROKER_RECONNECT_JITTER_RATIO,
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
    if (token === '--management-key' || token.startsWith('--management-key=')) {
      const next = readOptionValue(args, index, '--management-key');
      managementKeys.push(nonEmptyString(next.value));
      index += next.consumed;
      continue;
    }
    if (token === '--token' || token.startsWith('--token=')) {
      const next = readOptionValue(args, index, '--token');
      managementKeys.push(nonEmptyString(next.value));
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
    if (token === '--reconnect-max-delay-ms' || token.startsWith('--reconnect-max-delay-ms=')) {
      const next = readOptionValue(args, index, '--reconnect-max-delay-ms');
      options.reconnectMaxDelayMs = normalizePositiveInteger(
        next.value,
        DEFAULT_BROKER_RECONNECT_MAX_DELAY_MS,
        250,
        600000
      );
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
    brokerUrls.push(normalizeBrokerUrl(token));
    if (brokerUrls.length > MAX_BROKER_ENDPOINTS) {
      const error = new Error('too_many_fabric_broker_urls');
      error.code = 'too_many_fabric_broker_urls';
      throw error;
    }
    index += 1;
  }

  if (brokerUrls.length === 0) {
    const error = new Error('missing_fabric_broker_url');
    error.code = 'missing_fabric_broker_url';
    throw error;
  }
  if (!options.serverId) {
    const error = new Error('missing_fabric_broker_server_id');
    error.code = 'missing_fabric_broker_server_id';
    throw error;
  }
  if (managementKeys.length === 0 && nonEmptyString(env.AIH_MANAGEMENT_KEY)) {
    managementKeys.push(nonEmptyString(env.AIH_MANAGEMENT_KEY));
  }
  if (managementKeys.length === 0) {
    const error = new Error('missing_fabric_broker_management_key');
    error.code = 'missing_fabric_broker_management_key';
    throw error;
  }
  if (managementKeys.length !== brokerUrls.length) {
    const error = new Error('management_key_count_mismatch');
    error.code = 'management_key_count_mismatch';
    throw error;
  }
  options.localUrl = normalizeHttpUrl(options.localUrl, 'invalid_fabric_broker_local_url');
  options.brokers = brokerUrls.map((brokerUrl, index) => ({
    brokerUrl,
    managementKey: managementKeys[index]
  }));
  options.brokerUrl = options.brokers[0].brokerUrl;
  options.managementKey = options.brokers[0].managementKey;
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

function normalizeRegistrationDescriptor(options = {}, payload = {}) {
  const source = payload && typeof payload === 'object' && payload.result && typeof payload.result === 'object'
    ? payload.result
    : payload;
  const server = source && source.server && typeof source.server === 'object' ? source.server : {};
  return {
    stableServerId: options.serverId,
    name: nonEmptyString(options.serverName || server.name || source.name || options.serverId),
    capabilities: source && source.capabilities && typeof source.capabilities === 'object'
      ? source.capabilities
      : {},
    routes: Array.isArray(options.routes)
      ? options.routes
      : (Array.isArray(source && source.routes) ? source.routes : [])
  };
}

async function resolveBrokerServerDescriptor(options = {}, deps = {}) {
  if (options.descriptor && typeof options.descriptor === 'object') {
    return normalizeRegistrationDescriptor(options, options.descriptor);
  }
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') return normalizeRegistrationDescriptor(options, {});
  try {
    const response = await withTimeout(
      fetchImpl(buildLocalRequestUrl(options.localUrl, '/v0/fabric/descriptor'), {
        method: 'GET',
        headers: { accept: 'application/json' }
      }),
      Math.max(1000, Number(options.connectTimeoutMs) || DEFAULT_CONNECT_TIMEOUT_MS),
      'fabric_broker_descriptor_timeout'
    );
    if (!response || response.ok === false || typeof response.json !== 'function') {
      return normalizeRegistrationDescriptor(options, {});
    }
    return normalizeRegistrationDescriptor(options, await response.json());
  } catch (_error) {
    return normalizeRegistrationDescriptor(options, {});
  }
}

async function handleBrokerRequestFrame(socket, frame = {}, options = {}, deps = {}) {
  const handler = createBrokerRequestHandler(options, deps);
  return handler(socket, frame);
}

function getWebSocketClass(deps = {}) {
  if (deps.WebSocket) return deps.WebSocket;
  return require('ws');
}

async function connectFabricBroker(options = {}, deps = {}) {
  const WebSocketClass = getWebSocketClass(deps);
  const managementKey = nonEmptyString(options.managementKey || options.token);
  const socket = new WebSocketClass(buildBrokerSocketUrl(options).toString(), {
    headers: {
      authorization: `Bearer ${managementKey}`
    }
  });
  const helloPromise = waitForHello(socket, options.serverId);
  helloPromise.catch(() => {});
  await withTimeout(waitForOpen(socket), options.connectTimeoutMs, 'fabric_broker_connect_timeout');
  const hello = await withTimeout(helloPromise, options.connectTimeoutMs, 'fabric_broker_hello_timeout');
  let descriptorRefresh = null;
  const publishDescriptor = async () => {
    const descriptor = await resolveBrokerServerDescriptor(options, deps);
    sendJson(socket, {
      type: 'broker.register',
      serverId: options.serverId,
      descriptor
    });
  };
  const refreshDescriptor = () => {
    if (descriptorRefresh) return descriptorRefresh;
    descriptorRefresh = publishDescriptor().finally(() => {
      descriptorRefresh = null;
    });
    return descriptorRefresh;
  };
  await refreshDescriptor();
  const diagnostics = {
    connectedAt: Date.now(),
    lastHeartbeatAt: 0,
    lastPongAt: 0
  };
  const requestHandler = createBrokerRequestHandler(options, deps);
  const webSocketHandler = createBrokerWebSocketHandler(options, {
    ...deps,
    WebSocket: WebSocketClass
  });

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
    if (webSocketHandler(socket, frame)) return;
    if (!frame || (frame.type !== 'broker.request' && frame.type !== 'broker.request.cancel')) return;
    requestHandler(socket, frame);
  });

  const timer = setInterval(() => {
    diagnostics.lastHeartbeatAt = Date.now();
    sendJson(socket, { type: 'broker.heartbeat' });
    void refreshDescriptor().catch(() => {});
  }, options.heartbeatMs);
  if (timer && typeof timer.unref === 'function') timer.unref();
  const closedWithCleanup = closed.finally(async () => {
    clearInterval(timer);
    await Promise.all([requestHandler.close(), webSocketHandler.close()]);
  });

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

const calculateBrokerReconnectDelay = calculateReconnectDelay;

async function runBrokerConnectLoop(options = {}, deps = {}) {
  const connect = deps.connectFabricBroker || connectFabricBroker;
  const wait = deps.sleep || sleep;
  const random = deps.random || Math.random;
  let attempts = 0;
  let lastResult = null;
  while (!options.maxAttempts || attempts < options.maxAttempts) {
    attempts += 1;
    let handle = null;
    try {
      handle = await connect(options, deps);
    } catch (error) {
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
      await wait(calculateBrokerReconnectDelay(attempts, options, random), options);
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
    await wait(calculateBrokerReconnectDelay(attempts, options, random), options);
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
  const brokerOptions = options.brokers.map((broker) => ({
    ...options,
    brokerUrl: broker.brokerUrl,
    managementKey: broker.managementKey,
    brokers: [broker]
  }));

  async function runOne(connectionOptions) {
    if (!options.once) return runBrokerConnectLoop(connectionOptions, deps);
    const handle = await connect(connectionOptions, deps);
    handle.close();
    return {
      ...serializeBrokerConnection(handle, 1, 'once'),
      json: options.json
    };
  }

  if (brokerOptions.length === 1) {
    return runOne(brokerOptions[0]);
  }
  const connections = await Promise.all(brokerOptions.map(runOne));
  return {
    ok: connections.some((connection) => connection && connection.ok === true),
    json: options.json,
    serverId: options.serverId,
    localUrl: options.localUrl,
    mode: 'multi-broker',
    attempts: connections.reduce((sum, connection) => sum + (Number(connection.attempts) || 0), 0),
    connections
  };
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
  calculateBrokerReconnectDelay,
  connectFabricBroker,
  createBrokerRequestHandler,
  formatFabricBrokerConnectReport,
  handleBrokerRequestFrame,
  normalizeBrokerUrl,
  parseFabricBrokerConnectArgs,
  resolveBrokerServerDescriptor,
  runBrokerConnectLoop,
  runFabricBrokerConnect
};
