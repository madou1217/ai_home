'use strict';

const net = require('node:net');

const {
  isFlag,
  nonEmptyString,
  normalizePositiveInteger,
  readOptionValue
} = require('./option-parser');
const { summarizeRtt } = require('./transport-metrics');

const DEFAULT_TCP_ECHO_COUNT = 5;
const DEFAULT_TCP_ECHO_PAYLOAD_SIZE = 128;
const DEFAULT_TCP_ECHO_TIMEOUT_MS = 5000;
const DEFAULT_TCP_ECHO_INTERVAL_MS = 0;
const MAX_TCP_ECHO_COUNT = 10000;
const MAX_TCP_ECHO_PAYLOAD_SIZE = 1024 * 1024;

function nowMs(deps = {}) {
  return typeof deps.now === 'function' ? Number(deps.now()) : Date.now();
}

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
}

function normalizeTcpTarget(value) {
  const raw = nonEmptyString(value);
  if (!raw) {
    const error = new Error('missing_tcp_echo_target');
    error.code = 'missing_tcp_echo_target';
    throw error;
  }

  let url;
  try {
    url = new URL(raw);
  } catch (_error) {
    const error = new Error('invalid_tcp_echo_target');
    error.code = 'invalid_tcp_echo_target';
    error.target = raw;
    throw error;
  }

  if (url.protocol !== 'tcp:') {
    const error = new Error('invalid_tcp_echo_target_protocol');
    error.code = 'invalid_tcp_echo_target_protocol';
    error.target = raw;
    throw error;
  }
  const host = nonEmptyString(url.hostname);
  const port = normalizePositiveInteger(url.port, 0, 1, 65535);
  if (!host || port <= 0) {
    const error = new Error('invalid_tcp_echo_target');
    error.code = 'invalid_tcp_echo_target';
    error.target = raw;
    throw error;
  }

  return {
    raw,
    host,
    port,
    href: `tcp://${url.host}`
  };
}

function parseFabricTransportTcpEchoArgs(rawArgs = []) {
  const args = Array.isArray(rawArgs) ? rawArgs.map((item) => String(item)) : [];
  const options = {
    target: null,
    count: DEFAULT_TCP_ECHO_COUNT,
    payloadSize: DEFAULT_TCP_ECHO_PAYLOAD_SIZE,
    timeoutMs: DEFAULT_TCP_ECHO_TIMEOUT_MS,
    intervalMs: DEFAULT_TCP_ECHO_INTERVAL_MS,
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
    if (token === '--count' || token.startsWith('--count=')) {
      const next = readOptionValue(args, index, '--count');
      options.count = normalizePositiveInteger(next.value, DEFAULT_TCP_ECHO_COUNT, 1, MAX_TCP_ECHO_COUNT);
      index += next.consumed;
      continue;
    }
    if (token === '--payload-size' || token.startsWith('--payload-size=')) {
      const next = readOptionValue(args, index, '--payload-size');
      options.payloadSize = normalizePositiveInteger(next.value, DEFAULT_TCP_ECHO_PAYLOAD_SIZE, 0, MAX_TCP_ECHO_PAYLOAD_SIZE);
      index += next.consumed;
      continue;
    }
    if (token === '--timeout-ms' || token.startsWith('--timeout-ms=')) {
      const next = readOptionValue(args, index, '--timeout-ms');
      options.timeoutMs = normalizePositiveInteger(next.value, DEFAULT_TCP_ECHO_TIMEOUT_MS, 250, 120000);
      index += next.consumed;
      continue;
    }
    if (token === '--interval-ms' || token.startsWith('--interval-ms=')) {
      const next = readOptionValue(args, index, '--interval-ms');
      options.intervalMs = normalizePositiveInteger(next.value, DEFAULT_TCP_ECHO_INTERVAL_MS, 0, 60000);
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
      const error = new Error('too_many_tcp_echo_targets');
      error.code = 'too_many_tcp_echo_targets';
      throw error;
    }
    options.target = normalizeTcpTarget(token);
    index += 1;
  }

  if (!options.target) {
    const error = new Error('missing_tcp_echo_target');
    error.code = 'missing_tcp_echo_target';
    throw error;
  }
  return options;
}

function parseFabricTransportTcpEchoServerArgs(rawArgs = []) {
  const args = Array.isArray(rawArgs) ? rawArgs.map((item) => String(item)) : [];
  const options = {
    host: '127.0.0.1',
    port: 0,
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
    if (isFlag(token)) {
      const error = new Error(`unknown_option:${token}`);
      error.code = 'unknown_option';
      error.flag = token;
      throw error;
    }
    const error = new Error(`unexpected_tcp_echo_server_arg:${token}`);
    error.code = 'unexpected_tcp_echo_server_arg';
    error.value = token;
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

function closeTcpEchoServer(handle) {
  return new Promise((resolve) => {
    if (!handle || !handle.server) {
      resolve();
      return;
    }
    try {
      handle.server.close(() => resolve());
    } catch (_error) {
      resolve();
    }
  });
}

async function startFabricTransportTcpEchoServer(options = {}) {
  const server = net.createServer((socket) => {
    socket.on('data', (data) => {
      if (!socket.destroyed) socket.write(data);
    });
    socket.on('error', () => {});
  });

  const address = await listen(server, options.host || '127.0.0.1', Number(options.port) || 0);
  const host = address && address.address ? address.address : (options.host || '127.0.0.1');
  const port = Number(address && address.port) || Number(options.port) || 0;
  return {
    ok: true,
    host,
    port,
    protocol: 'tcp',
    url: `tcp://${host}:${port}`,
    server,
    close: null
  };
}

function waitForConnect(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(Object.assign(new Error('tcp_echo_connect_timeout'), { code: 'tcp_echo_connect_timeout' }));
    }, timeoutMs);
    if (timer && typeof timer.unref === 'function') timer.unref();

    function cleanup() {
      clearTimeout(timer);
      socket.off('connect', onConnect);
      socket.off('error', onError);
    }
    function onConnect() {
      cleanup();
      resolve();
    }
    function onError(error) {
      cleanup();
      reject(error);
    }
    socket.once('connect', onConnect);
    socket.once('error', onError);
  });
}

function waitForTcpEcho(socket, expected, timeoutMs) {
  return new Promise((resolve, reject) => {
    let received = Buffer.alloc(0);
    const timer = setTimeout(() => {
      cleanup();
      reject(Object.assign(new Error('tcp_echo_response_timeout'), { code: 'tcp_echo_response_timeout' }));
    }, timeoutMs);
    if (timer && typeof timer.unref === 'function') timer.unref();

    function cleanup() {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('close', onClose);
      socket.off('error', onError);
    }
    function onData(data) {
      received = Buffer.concat([received, Buffer.from(data)]);
      if (received.length < expected.length) return;
      cleanup();
      if (received.subarray(0, expected.length).equals(expected)) {
        resolve(received.subarray(0, expected.length));
        return;
      }
      reject(Object.assign(new Error('tcp_echo_mismatch'), { code: 'tcp_echo_mismatch' }));
    }
    function onClose() {
      cleanup();
      reject(Object.assign(new Error('tcp_echo_socket_closed'), { code: 'tcp_echo_socket_closed' }));
    }
    function onError(error) {
      cleanup();
      reject(error);
    }
    socket.on('data', onData);
    socket.once('close', onClose);
    socket.once('error', onError);
  });
}

function buildTcpEchoPayload(index, payloadSize) {
  const header = `aih.fabric.tcp.echo:${index}:`;
  return Buffer.from(`${header}${payloadSize > 0 ? 'x'.repeat(payloadSize) : ''}`, 'utf8');
}

function closeSocket(socket) {
  if (!socket || socket.destroyed) return;
  try {
    socket.end();
    socket.destroy();
  } catch (_error) {}
}

async function runFabricTransportTcpEcho(rawArgs = [], deps = {}) {
  const options = parseFabricTransportTcpEchoArgs(rawArgs);
  const socket = net.createConnection({
    host: options.target.host,
    port: options.target.port
  });
  const samples = [];
  const failures = [];
  const startedAt = nowMs(deps);

  try {
    await waitForConnect(socket, options.timeoutMs);
    for (let index = 0; index < options.count; index += 1) {
      const payload = buildTcpEchoPayload(index + 1, options.payloadSize);
      const sentAt = nowMs(deps);
      socket.write(payload);
      try {
        const echoed = await waitForTcpEcho(socket, payload, options.timeoutMs);
        samples.push({
          id: `tcp-echo-${index + 1}`,
          rttMs: Math.max(0, nowMs(deps) - sentAt),
          payloadBytes: echoed.length
        });
      } catch (error) {
        failures.push({ id: `tcp-echo-${index + 1}`, error: String((error && error.code) || (error && error.message) || 'tcp_echo_failed') });
      }
      if (options.intervalMs > 0 && index < options.count - 1) await sleep(options.intervalMs);
    }
  } catch (error) {
    failures.push({ id: 'connect', error: String((error && error.code) || (error && error.message) || 'tcp_echo_connect_failed') });
  } finally {
    closeSocket(socket);
  }

  const summary = summarizeRtt(samples);
  return {
    ok: failures.length === 0 && samples.length === options.count,
    generatedAt: new Date(nowMs(deps)).toISOString(),
    command: 'aih fabric transport tcp-echo',
    target: options.target.href,
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

function formatFabricTransportTcpEchoReport(result = {}) {
  const rtt = result.rttMs || {};
  const lines = [
    '[aih] fabric transport tcp-echo',
    `[aih] generated: ${result.generatedAt || ''}`,
    `[aih] target: ${result.target || ''}`,
    `[aih] count: ${Number(result.successes || 0)}/${Number(result.count || 0)} payload=${Number(result.payloadSize || 0)}B`,
    `[aih] rtt: min=${Number(rtt.min || 0)}ms p50=${Number(rtt.p50 || 0)}ms p95=${Number(rtt.p95 || 0)}ms max=${Number(rtt.max || 0)}ms avg=${Number(rtt.avg || 0)}ms`
  ];
  if (Array.isArray(result.failures) && result.failures.length) {
    lines.push('[aih] failures:');
    result.failures.forEach((failure) => {
      lines.push(`- ${failure.id || 'unknown'} ${failure.error || 'tcp_echo_failed'}`);
    });
  }
  lines.push(`[aih] result: ${result.ok ? 'pass' : 'fail'}`);
  return lines.join('\n');
}

function formatFabricTransportTcpEchoServerReady(result = {}) {
  return [
    '[aih] fabric transport tcp-echo-server',
    `[aih] url: ${result.url || ''}`,
    '[aih] mode: foreground; press Ctrl+C to stop'
  ].join('\n');
}

async function runFabricTransportTcpEchoServer(rawArgs = [], deps = {}) {
  const options = parseFabricTransportTcpEchoServerArgs(rawArgs);
  const processObj = deps.processObj || process;
  const handle = await startFabricTransportTcpEchoServer(options);
  handle.close = () => closeTcpEchoServer(handle);

  if (deps.returnServer) return handle;

  if (options.json) {
    processObj.stdout.write(`${JSON.stringify({
      ok: true,
      command: 'aih fabric transport tcp-echo-server',
      url: handle.url,
      host: handle.host,
      port: handle.port,
      protocol: handle.protocol
    })}\n`);
  } else {
    processObj.stdout.write(`${formatFabricTransportTcpEchoServerReady(handle)}\n`);
  }

  return new Promise((resolve) => {
    let settled = false;
    async function shutdown() {
      if (settled) return;
      settled = true;
      await closeTcpEchoServer(handle);
      resolve({ ok: true, closed: true });
    }
    if (typeof processObj.once === 'function') {
      processObj.once('SIGINT', shutdown);
      processObj.once('SIGTERM', shutdown);
    }
  });
}

module.exports = {
  DEFAULT_TCP_ECHO_COUNT,
  DEFAULT_TCP_ECHO_PAYLOAD_SIZE,
  DEFAULT_TCP_ECHO_TIMEOUT_MS,
  closeTcpEchoServer,
  formatFabricTransportTcpEchoReport,
  formatFabricTransportTcpEchoServerReady,
  parseFabricTransportTcpEchoArgs,
  parseFabricTransportTcpEchoServerArgs,
  runFabricTransportTcpEcho,
  runFabricTransportTcpEchoServer,
  startFabricTransportTcpEchoServer
};
