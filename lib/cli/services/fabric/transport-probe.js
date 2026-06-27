'use strict';

const net = require('node:net');

const {
  isFlag,
  nonEmptyString,
  normalizePositiveInteger,
  readOptionValue
} = require('./option-parser');

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_HTTP_METHOD = 'HEAD';

function normalizeHttpMethod(value) {
  const method = nonEmptyString(value || DEFAULT_HTTP_METHOD).toUpperCase();
  if (method === 'HEAD' || method === 'GET') return method;
  const error = new Error(`unsupported_http_method:${method}`);
  error.code = 'unsupported_http_method';
  error.method = method;
  throw error;
}

function defaultPortForProtocol(protocol) {
  if (protocol === 'http:' || protocol === 'ws:') return 80;
  if (protocol === 'https:' || protocol === 'wss:') return 443;
  return 0;
}

function parseHostPort(value) {
  const raw = nonEmptyString(value);
  const ipv6 = raw.match(/^\[([^\]]+)]:(\d{1,5})$/);
  if (ipv6) {
    return {
      host: ipv6[1],
      port: normalizePositiveInteger(ipv6[2], 0, 1, 65535)
    };
  }
  const match = raw.match(/^([^:/]+):(\d{1,5})$/);
  if (!match) return { host: raw, port: 0 };
  return {
    host: match[1],
    port: normalizePositiveInteger(match[2], 0, 1, 65535)
  };
}

function normalizeProbeTarget(value) {
  const raw = nonEmptyString(value);
  if (!raw) {
    const error = new Error('missing_probe_target');
    error.code = 'missing_probe_target';
    throw error;
  }

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    let url;
    try {
      url = new URL(raw);
    } catch (_error) {
      const error = new Error('invalid_probe_target_url');
      error.code = 'invalid_probe_target_url';
      error.target = raw;
      throw error;
    }
    const protocol = url.protocol.toLowerCase();
    const port = Number(url.port) || defaultPortForProtocol(protocol);
    if (!url.hostname || !port) {
      const error = new Error('invalid_probe_target_endpoint');
      error.code = 'invalid_probe_target_endpoint';
      error.target = raw;
      throw error;
    }
    if (protocol === 'http:' || protocol === 'https:') {
      return {
        raw,
        kind: 'http',
        protocol: protocol.replace(/:$/, ''),
        url: url.toString(),
        host: url.hostname,
        port
      };
    }
    if (protocol === 'tcp:' || protocol === 'ws:' || protocol === 'wss:') {
      return {
        raw,
        kind: protocol === 'tcp:' ? 'tcp' : 'tcp-upgrade',
        protocol: protocol.replace(/:$/, ''),
        url: url.toString(),
        host: url.hostname,
        port
      };
    }
  }

  const parsed = parseHostPort(raw);
  if (!parsed.host || !parsed.port) {
    const error = new Error('invalid_probe_target_host_port');
    error.code = 'invalid_probe_target_host_port';
    error.target = raw;
    throw error;
  }
  return {
    raw,
    kind: 'tcp',
    protocol: 'tcp',
    host: parsed.host,
    port: parsed.port,
    url: `tcp://${parsed.host}:${parsed.port}`
  };
}

function parseFabricTransportProbeArgs(rawArgs = []) {
  const args = Array.isArray(rawArgs) ? rawArgs.map((item) => String(item)) : [];
  const options = {
    targets: [],
    timeoutMs: DEFAULT_TIMEOUT_MS,
    httpMethod: DEFAULT_HTTP_METHOD,
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
    if (token === '--timeout-ms' || token.startsWith('--timeout-ms=')) {
      const next = readOptionValue(args, index, '--timeout-ms');
      options.timeoutMs = normalizePositiveInteger(next.value, DEFAULT_TIMEOUT_MS, 250, 120000);
      index += next.consumed;
      continue;
    }
    if (token === '--method' || token.startsWith('--method=')) {
      const next = readOptionValue(args, index, '--method');
      options.httpMethod = normalizeHttpMethod(next.value);
      index += next.consumed;
      continue;
    }
    if (isFlag(token)) {
      const error = new Error(`unknown_option:${token}`);
      error.code = 'unknown_option';
      error.flag = token;
      throw error;
    }
    options.targets.push(normalizeProbeTarget(token));
    index += 1;
  }

  if (options.targets.length === 0) {
    const error = new Error('missing_probe_target');
    error.code = 'missing_probe_target';
    throw error;
  }
  return options;
}

function nowMs(deps = {}) {
  return typeof deps.now === 'function' ? Number(deps.now()) : Date.now();
}

function createTimeoutSignal(timeoutMs) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  if (!controller) return { signal: undefined, cleanup: () => {} };
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (timer && typeof timer.unref === 'function') timer.unref();
  return {
    signal: controller.signal,
    cleanup: () => clearTimeout(timer)
  };
}

function probeTcpTarget(target, options = {}, deps = {}) {
  const netImpl = deps.netImpl || net;
  const timeoutMs = normalizePositiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 250, 120000);
  const startedAt = nowMs(deps);
  return new Promise((resolve) => {
    const socket = netImpl.createConnection({ host: target.host, port: target.port });
    let settled = false;

    function finish(patch) {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch (_error) {}
      resolve({
        target: target.raw,
        normalizedTarget: target.url || `${target.host}:${target.port}`,
        kind: target.kind,
        protocol: target.protocol,
        host: target.host,
        port: target.port,
        durationMs: Math.max(0, nowMs(deps) - startedAt),
        ...patch
      });
    }

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish({ reachable: true, status: 'reachable' }));
    socket.once('timeout', () => finish({ reachable: false, status: 'timeout', error: 'connect_timeout' }));
    socket.once('error', (error) => finish({
      reachable: false,
      status: 'error',
      error: String((error && error.code) || (error && error.message) || 'tcp_connect_failed')
    }));
  });
}

async function probeHttpTarget(target, options = {}, deps = {}) {
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const timeoutMs = normalizePositiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 250, 120000);
  const startedAt = nowMs(deps);
  if (typeof fetchImpl !== 'function') {
    return {
      target: target.raw,
      normalizedTarget: target.url,
      kind: target.kind,
      protocol: target.protocol,
      host: target.host,
      port: target.port,
      reachable: false,
      status: 'error',
      durationMs: 0,
      error: 'fetch_unavailable'
    };
  }
  const linked = createTimeoutSignal(timeoutMs);
  try {
    const response = await fetchImpl(target.url, {
      method: normalizeHttpMethod(options.httpMethod),
      redirect: 'manual',
      signal: linked.signal
    });
    const httpOk = Boolean(response && response.ok);
    return {
      target: target.raw,
      normalizedTarget: target.url,
      kind: target.kind,
      protocol: target.protocol,
      host: target.host,
      port: target.port,
      reachable: true,
      networkReachable: true,
      serviceHealthy: httpOk,
      status: 'reachable',
      durationMs: Math.max(0, nowMs(deps) - startedAt),
      http: {
        status: Number(response && response.status) || 0,
        ok: httpOk,
        redirected: Boolean(response && response.redirected)
      }
    };
  } catch (error) {
    return {
      target: target.raw,
      normalizedTarget: target.url,
      kind: target.kind,
      protocol: target.protocol,
      host: target.host,
      port: target.port,
      reachable: false,
      networkReachable: false,
      serviceHealthy: false,
      status: error && error.name === 'AbortError' ? 'timeout' : 'error',
      durationMs: Math.max(0, nowMs(deps) - startedAt),
      error: error && error.name === 'AbortError'
        ? 'http_probe_timeout'
        : String((error && error.code) || (error && error.message) || 'http_probe_failed')
    };
  } finally {
    linked.cleanup();
  }
}

async function probeTarget(target, options = {}, deps = {}) {
  if (typeof deps.probeImpl === 'function') return deps.probeImpl(target, options, deps);
  if (target.kind === 'http') return probeHttpTarget(target, options, deps);
  return probeTcpTarget(target, options, deps);
}

async function runFabricTransportProbe(rawArgs = [], deps = {}) {
  const options = parseFabricTransportProbeArgs(rawArgs);
  const generatedAt = new Date(nowMs(deps)).toISOString();
  const probes = [];
  for (const target of options.targets) {
    // Sequential by design: this is a small evidence command, not a load test.
    probes.push(await probeTarget(target, options, deps));
  }
  const networkOk = probes.every((probe) => (
    probe.networkReachable === undefined ? probe.reachable : probe.networkReachable
  ));
  return {
    ok: networkOk,
    generatedAt,
    command: 'aih fabric transport probe',
    timeoutMs: options.timeoutMs,
    httpMethod: options.httpMethod,
    probes,
    json: options.json
  };
}

function formatFabricTransportProbeReport(result = {}) {
  const lines = [
    '[aih] fabric transport probe',
    `[aih] generated: ${result.generatedAt || ''}`,
    `[aih] timeout: ${Number(result.timeoutMs || 0) || DEFAULT_TIMEOUT_MS}ms`
  ];
  const probes = Array.isArray(result.probes) ? result.probes : [];
  probes.forEach((probe) => {
    const status = probe.reachable ? 'ok' : 'fail';
    const endpoint = probe.normalizedTarget || probe.target || '';
    const duration = Number.isFinite(Number(probe.durationMs)) ? `${Number(probe.durationMs)}ms` : 'n/a';
    let detail = probe.error ? ` error=${probe.error}` : '';
    if (probe.http && Number(probe.http.status)) {
      detail = ` http=${probe.http.status} service=${probe.serviceHealthy ? 'healthy' : 'unhealthy'}`;
    }
    lines.push(`- ${status} ${endpoint} ${duration}${detail}`);
  });
  lines.push(`[aih] result: ${result.ok ? 'pass' : 'fail'}`);
  return lines.join('\n');
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_HTTP_METHOD,
  formatFabricTransportProbeReport,
  normalizeProbeTarget,
  parseFabricTransportProbeArgs,
  probeHttpTarget,
  probeTcpTarget,
  runFabricTransportProbe
};
