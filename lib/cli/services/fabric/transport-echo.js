'use strict';

const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');

const {
  isFlag,
  nonEmptyString,
  normalizePositiveInteger,
  readOptionValue
} = require('./option-parser');
const { summarizeRtt } = require('./transport-metrics');

const DEFAULT_ECHO_COUNT = 5;
const DEFAULT_ECHO_PAYLOAD_SIZE = 128;
const DEFAULT_ECHO_TIMEOUT_MS = 5000;
const DEFAULT_ECHO_INTERVAL_MS = 0;
const DEFAULT_ECHO_PATH = '/';
const MAX_ECHO_COUNT = 10000;
const MAX_ECHO_PAYLOAD_SIZE = 1024 * 1024;

function nowMs(deps = {}) {
  return typeof deps.now === 'function' ? Number(deps.now()) : Date.now();
}

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
}

function getWebSocketClass(deps = {}) {
  if (deps.WebSocket) return deps.WebSocket;
  return require('ws');
}

function resolveManagementKey(deps = {}) {
  if (Object.prototype.hasOwnProperty.call(deps, 'managementKey')) {
    return nonEmptyString(deps.managementKey);
  }
  const env = deps.processObj && deps.processObj.env ? deps.processObj.env : process.env;
  return nonEmptyString(env && env.AIH_MANAGEMENT_KEY);
}

function normalizeWsPath(value) {
  const path = nonEmptyString(value || DEFAULT_ECHO_PATH);
  return path.startsWith('/') ? path : `/${path}`;
}

function normalizeWsUrl(value) {
  const raw = nonEmptyString(value);
  if (!raw) {
    const error = new Error('missing_echo_target');
    error.code = 'missing_echo_target';
    throw error;
  }
  let url;
  try {
    url = new URL(raw);
  } catch (_error) {
    const error = new Error('invalid_echo_target');
    error.code = 'invalid_echo_target';
    error.target = raw;
    throw error;
  }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    const error = new Error('invalid_echo_target_protocol');
    error.code = 'invalid_echo_target_protocol';
    error.target = raw;
    throw error;
  }
  return url;
}

function parseFabricTransportEchoArgs(rawArgs = []) {
  const args = Array.isArray(rawArgs) ? rawArgs.map((item) => String(item)) : [];
  const options = {
    target: null,
    count: DEFAULT_ECHO_COUNT,
    payloadSize: DEFAULT_ECHO_PAYLOAD_SIZE,
    timeoutMs: DEFAULT_ECHO_TIMEOUT_MS,
    intervalMs: DEFAULT_ECHO_INTERVAL_MS,
    insecure: false,
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
    if (token === '--insecure') {
      options.insecure = true;
      index += 1;
      continue;
    }
    if (token === '--count' || token.startsWith('--count=')) {
      const next = readOptionValue(args, index, '--count');
      options.count = normalizePositiveInteger(next.value, DEFAULT_ECHO_COUNT, 1, MAX_ECHO_COUNT);
      index += next.consumed;
      continue;
    }
    if (token === '--payload-size' || token.startsWith('--payload-size=')) {
      const next = readOptionValue(args, index, '--payload-size');
      options.payloadSize = normalizePositiveInteger(next.value, DEFAULT_ECHO_PAYLOAD_SIZE, 0, MAX_ECHO_PAYLOAD_SIZE);
      index += next.consumed;
      continue;
    }
    if (token === '--timeout-ms' || token.startsWith('--timeout-ms=')) {
      const next = readOptionValue(args, index, '--timeout-ms');
      options.timeoutMs = normalizePositiveInteger(next.value, DEFAULT_ECHO_TIMEOUT_MS, 250, 120000);
      index += next.consumed;
      continue;
    }
    if (token === '--interval-ms' || token.startsWith('--interval-ms=')) {
      const next = readOptionValue(args, index, '--interval-ms');
      options.intervalMs = normalizePositiveInteger(next.value, DEFAULT_ECHO_INTERVAL_MS, 0, 60000);
      index += next.consumed;
      continue;
    }
    if (isFlag(token)) {
      const error = new Error(`unknown_option:${token}`);
      error.code = 'unknown_option';
      error.flag = token;
      throw error;
    }
    if (options.target) {
      const error = new Error('too_many_echo_targets');
      error.code = 'too_many_echo_targets';
      throw error;
    }
    options.target = normalizeWsUrl(token);
    index += 1;
  }

  if (!options.target) {
    const error = new Error('missing_echo_target');
    error.code = 'missing_echo_target';
    throw error;
  }
  return options;
}

function parseFabricTransportEchoServerArgs(rawArgs = []) {
  const args = Array.isArray(rawArgs) ? rawArgs.map((item) => String(item)) : [];
  const options = {
    host: '127.0.0.1',
    port: 0,
    path: DEFAULT_ECHO_PATH,
    tlsKey: '',
    tlsCert: '',
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
    if (token === '--host' || token.startsWith('--host=')) {
      const next = readOptionValue(args, index, '--host');
      options.host = nonEmptyString(next.value) || options.host;
      index += next.consumed;
      continue;
    }
    if (token === '--port' || token.startsWith('--port=')) {
      const next = readOptionValue(args, index, '--port');
      options.port = normalizePositiveInteger(next.value, 0, 0, 65535);
      index += next.consumed;
      continue;
    }
    if (token === '--path' || token.startsWith('--path=')) {
      const next = readOptionValue(args, index, '--path');
      options.path = normalizeWsPath(next.value);
      index += next.consumed;
      continue;
    }
    if (token === '--tls-key' || token.startsWith('--tls-key=')) {
      const next = readOptionValue(args, index, '--tls-key');
      options.tlsKey = nonEmptyString(next.value);
      index += next.consumed;
      continue;
    }
    if (token === '--tls-cert' || token.startsWith('--tls-cert=')) {
      const next = readOptionValue(args, index, '--tls-cert');
      options.tlsCert = nonEmptyString(next.value);
      index += next.consumed;
      continue;
    }
    if (isFlag(token)) {
      const error = new Error(`unknown_option:${token}`);
      error.code = 'unknown_option';
      error.flag = token;
      throw error;
    }
    const error = new Error(`unexpected_echo_server_arg:${token}`);
    error.code = 'unexpected_echo_server_arg';
    error.value = token;
    throw error;
  }

  if (Boolean(options.tlsKey) !== Boolean(options.tlsCert)) {
    const error = new Error('incomplete_echo_tls_config');
    error.code = 'incomplete_echo_tls_config';
    throw error;
  }
  return options;
}

function listen(server, host, port) {
  return new Promise((resolve, reject) => {
    function cleanup() {
      server.off('error', onError);
    }
    function onError(error) {
      cleanup();
      reject(error);
    }
    server.once('error', onError);
    server.listen(port, host, () => {
      cleanup();
      resolve(server.address());
    });
  });
}

function closeEchoServer(handle) {
  return new Promise((resolve) => {
    if (!handle || !handle.server) {
      resolve();
      return;
    }
    try {
      if (handle.webSocketServer && typeof handle.webSocketServer.close === 'function') {
        handle.webSocketServer.close();
      }
      handle.server.close(() => resolve());
    } catch (_error) {
      resolve();
    }
  });
}

async function startFabricTransportEchoServer(options = {}, deps = {}) {
  const WebSocket = getWebSocketClass(deps);
  const path = normalizeWsPath(options.path);
  const useTls = Boolean(options.tlsKey && options.tlsCert);
  const server = useTls
    ? https.createServer({
      key: fs.readFileSync(options.tlsKey),
      cert: fs.readFileSync(options.tlsCert)
    })
    : http.createServer();
  const webSocketServer = new WebSocket.Server({ server, path });

  webSocketServer.on('connection', (socket) => {
    socket.on('message', (data) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(data);
    });
  });

  const address = await listen(server, options.host || '127.0.0.1', Number(options.port) || 0);
  const host = address && address.address ? address.address : (options.host || '127.0.0.1');
  const port = Number(address && address.port) || Number(options.port) || 0;
  const protocol = useTls ? 'wss' : 'ws';
  return {
    ok: true,
    host,
    port,
    path,
    protocol,
    url: `${protocol}://${host}:${port}${path}`,
    server,
    webSocketServer,
    close: null
  };
}

function buildEchoFrame(index, payloadSize, sentAt) {
  return {
    type: 'aih.fabric.echo',
    id: `echo-${index}`,
    sentAt,
    payload: payloadSize > 0 ? 'x'.repeat(payloadSize) : ''
  };
}

function waitForOpen(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(Object.assign(new Error('echo_open_timeout'), { code: 'echo_open_timeout' }));
    }, timeoutMs);
    if (timer && typeof timer.unref === 'function') timer.unref();

    function cleanup() {
      clearTimeout(timer);
      socket.off('open', onOpen);
      socket.off('error', onError);
      socket.off('unexpected-response', onUnexpectedResponse);
    }
    function onOpen() {
      cleanup();
      resolve();
    }
    function onError(error) {
      cleanup();
      reject(error);
    }
    function onUnexpectedResponse(_request, response) {
      cleanup();
      const error = new Error(`echo_http_${response && response.statusCode}`);
      error.code = 'echo_upgrade_rejected';
      error.statusCode = response && response.statusCode;
      reject(error);
    }
    socket.once('open', onOpen);
    socket.once('error', onError);
    socket.once('unexpected-response', onUnexpectedResponse);
  });
}

function waitForEcho(socket, frameId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(Object.assign(new Error('echo_response_timeout'), { code: 'echo_response_timeout' }));
    }, timeoutMs);
    if (timer && typeof timer.unref === 'function') timer.unref();

    function cleanup() {
      clearTimeout(timer);
      socket.off('message', onMessage);
      socket.off('close', onClose);
      socket.off('error', onError);
    }
    function onMessage(data) {
      let payload = null;
      try {
        payload = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data || ''));
      } catch (_error) {
        return;
      }
      if (!payload || payload.id !== frameId) return;
      cleanup();
      resolve(payload);
    }
    function onClose() {
      cleanup();
      reject(Object.assign(new Error('echo_socket_closed'), { code: 'echo_socket_closed' }));
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

function closeSocket(socket) {
  if (!socket || socket.readyState === 2 || socket.readyState === 3) return;
  try {
    if (socket.readyState === 0) {
      socket.once('error', () => {});
      if (typeof socket.terminate === 'function') {
        socket.terminate();
        return;
      }
    }
    socket.close();
  } catch (_error) {}
}

async function runFabricTransportEcho(rawArgs = [], deps = {}) {
  const options = parseFabricTransportEchoArgs(rawArgs);
  const WebSocket = getWebSocketClass(deps);
  const target = options.target.toString();
  const managementKey = resolveManagementKey(deps);
  const socketOptions = {
    ...(options.insecure && options.target.protocol === 'wss:' ? { rejectUnauthorized: false } : {}),
    ...(managementKey ? { headers: { authorization: `Bearer ${managementKey}` } } : {})
  };
  const socket = new WebSocket(target, Object.keys(socketOptions).length > 0 ? socketOptions : undefined);
  const samples = [];
  const failures = [];
  const startedAt = nowMs(deps);

  try {
    await waitForOpen(socket, options.timeoutMs);
    for (let index = 0; index < options.count; index += 1) {
      const sentAt = nowMs(deps);
      const frame = buildEchoFrame(index + 1, options.payloadSize, sentAt);
      socket.send(JSON.stringify(frame));
      try {
        const echoed = await waitForEcho(socket, frame.id, options.timeoutMs);
        samples.push({
          id: frame.id,
          rttMs: Math.max(0, nowMs(deps) - sentAt),
          payloadBytes: Buffer.byteLength(String(echoed.payload || ''), 'utf8')
        });
      } catch (error) {
        failures.push({ id: frame.id, error: String((error && error.code) || (error && error.message) || 'echo_failed') });
      }
      if (options.intervalMs > 0 && index < options.count - 1) await sleep(options.intervalMs);
    }
  } catch (error) {
    failures.push({ id: 'connect', error: String((error && error.code) || (error && error.message) || 'echo_connect_failed') });
  } finally {
    closeSocket(socket);
  }

  const summary = summarizeRtt(samples);
  return {
    ok: failures.length === 0 && samples.length === options.count,
    generatedAt: new Date(nowMs(deps)).toISOString(),
    command: 'aih fabric transport echo',
    target,
    count: options.count,
    payloadSize: options.payloadSize,
    durationMs: Math.max(0, nowMs(deps) - startedAt),
    successes: samples.length,
    failures,
    rttMs: summary,
    samples,
    json: options.json
  };
}

function formatFabricTransportEchoReport(result = {}) {
  const rtt = result.rttMs || {};
  const lines = [
    '[aih] fabric transport echo',
    `[aih] generated: ${result.generatedAt || ''}`,
    `[aih] target: ${result.target || ''}`,
    `[aih] count: ${Number(result.successes || 0)}/${Number(result.count || 0)} payload=${Number(result.payloadSize || 0)}B`,
    `[aih] rtt: min=${Number(rtt.min || 0)}ms p50=${Number(rtt.p50 || 0)}ms p95=${Number(rtt.p95 || 0)}ms max=${Number(rtt.max || 0)}ms avg=${Number(rtt.avg || 0)}ms`
  ];
  if (Array.isArray(result.failures) && result.failures.length) {
    lines.push('[aih] failures:');
    result.failures.forEach((failure) => {
      lines.push(`- ${failure.id || 'unknown'} ${failure.error || 'echo_failed'}`);
    });
  }
  lines.push(`[aih] result: ${result.ok ? 'pass' : 'fail'}`);
  return lines.join('\n');
}

function formatFabricTransportEchoServerReady(result = {}) {
  return [
    '[aih] fabric transport echo-server',
    `[aih] url: ${result.url || ''}`,
    '[aih] mode: foreground; press Ctrl+C to stop'
  ].join('\n');
}

async function runFabricTransportEchoServer(rawArgs = [], deps = {}) {
  const options = parseFabricTransportEchoServerArgs(rawArgs);
  const processObj = deps.processObj || process;
  const handle = await startFabricTransportEchoServer(options, deps);
  handle.close = () => closeEchoServer(handle);

  if (deps.returnServer) return handle;

  if (options.json) {
    processObj.stdout.write(`${JSON.stringify({
      ok: true,
      command: 'aih fabric transport echo-server',
      url: handle.url,
      host: handle.host,
      port: handle.port,
      path: handle.path,
      protocol: handle.protocol
    })}\n`);
  } else {
    processObj.stdout.write(`${formatFabricTransportEchoServerReady(handle)}\n`);
  }

  return new Promise((resolve) => {
    let settled = false;
    async function shutdown() {
      if (settled) return;
      settled = true;
      await closeEchoServer(handle);
      resolve({ ok: true, closed: true });
    }
    if (typeof processObj.once === 'function') {
      processObj.once('SIGINT', shutdown);
      processObj.once('SIGTERM', shutdown);
    }
  });
}

module.exports = {
  DEFAULT_ECHO_COUNT,
  DEFAULT_ECHO_PAYLOAD_SIZE,
  DEFAULT_ECHO_TIMEOUT_MS,
  closeEchoServer,
  formatFabricTransportEchoReport,
  formatFabricTransportEchoServerReady,
  parseFabricTransportEchoArgs,
  parseFabricTransportEchoServerArgs,
  runFabricTransportEcho,
  runFabricTransportEchoServer,
  startFabricTransportEchoServer,
  summarizeRtt
};
