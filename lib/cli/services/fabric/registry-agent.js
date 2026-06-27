'use strict';

const {
  isFlag,
  nonEmptyString,
  normalizePositiveInteger,
  readOptionValue
} = require('./option-parser');
const fs = require('node:fs');
const path = require('node:path');
const {
  normalizeEndpoint,
  normalizeNodeId,
  parseTransportHeartbeat,
  postFabricRegistryHeartbeat
} = require('./registry-heartbeat');
const {
  runFabricTransportProbe
} = require('./transport-probe');
const {
  runFabricTransportEcho
} = require('./transport-echo');
const {
  runFabricTransportTcpEcho
} = require('./transport-tcp-echo');

const DEFAULT_AGENT_INTERVAL_MS = 30000;
const DEFAULT_AGENT_PROBE_COUNT = 1;
const DEFAULT_AGENT_PROBE_PAYLOAD_SIZE = 32;

function hasJsonFlag(args = []) {
  return args.some((item) => {
    const token = nonEmptyString(item);
    return token === '--json';
  });
}

function resolveHomePath(value, env = process.env) {
  const text = nonEmptyString(value);
  if (!text) return '';
  if (text === '~') return nonEmptyString(env.HOME || env.USERPROFILE) || text;
  if (text.startsWith('~/') || text.startsWith('~\\')) {
    const home = nonEmptyString(env.HOME || env.USERPROFILE);
    return home ? path.join(home, text.slice(2)) : text;
  }
  return text;
}

function readTokenFile(filePath, deps = {}) {
  const fsImpl = deps.fs || fs;
  const env = deps.env || process.env || {};
  const resolved = path.resolve(resolveHomePath(filePath, env));
  try {
    return nonEmptyString(fsImpl.readFileSync(resolved, 'utf8'));
  } catch (error) {
    const wrapped = new Error('fabric_token_file_unreadable');
    wrapped.code = 'fabric_token_file_unreadable';
    wrapped.file = resolved;
    wrapped.cause = error;
    throw wrapped;
  }
}

function parseFabricRegistryAgentArgs(rawArgs = [], deps = {}) {
  const args = Array.isArray(rawArgs) ? rawArgs.map((item) => String(item)) : [];
  const options = {
    endpoint: '',
    token: nonEmptyString((deps.env || process.env || {}).AIH_FABRIC_TOKEN),
    tokenFile: resolveHomePath((deps.env || process.env || {}).AIH_FABRIC_TOKEN_FILE, deps.env || process.env || {}),
    nodeId: '',
    status: 'online',
    relayStatus: '',
    transports: [],
    probeTransports: [],
    probeTimeoutMs: 5000,
    probeMethod: 'HEAD',
    probeCount: DEFAULT_AGENT_PROBE_COUNT,
    probePayloadSize: DEFAULT_AGENT_PROBE_PAYLOAD_SIZE,
    intervalMs: DEFAULT_AGENT_INTERVAL_MS,
    count: 0,
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
      options.count = 1;
      index += 1;
      continue;
    }
    if (token === '--count' || token.startsWith('--count=')) {
      const next = readOptionValue(args, index, '--count');
      options.count = normalizePositiveInteger(next.value, 0, 0, 1000000);
      index += next.consumed;
      continue;
    }
    if (token === '--interval-ms' || token.startsWith('--interval-ms=')) {
      const next = readOptionValue(args, index, '--interval-ms');
      options.intervalMs = normalizePositiveInteger(next.value, DEFAULT_AGENT_INTERVAL_MS, 1000, 24 * 60 * 60 * 1000);
      index += next.consumed;
      continue;
    }
    if (token === '--probe-timeout-ms' || token.startsWith('--probe-timeout-ms=')) {
      const next = readOptionValue(args, index, '--probe-timeout-ms');
      options.probeTimeoutMs = normalizePositiveInteger(next.value, 5000, 250, 120000);
      index += next.consumed;
      continue;
    }
    if (token === '--probe-method' || token.startsWith('--probe-method=')) {
      const next = readOptionValue(args, index, '--probe-method');
      const method = nonEmptyString(next.value).toUpperCase();
      if (method !== 'HEAD' && method !== 'GET') {
        const error = new Error('unsupported_http_method');
        error.code = 'unsupported_http_method';
        error.method = method;
        throw error;
      }
      options.probeMethod = method;
      index += next.consumed;
      continue;
    }
    if (token === '--probe-count' || token.startsWith('--probe-count=')) {
      const next = readOptionValue(args, index, '--probe-count');
      options.probeCount = normalizePositiveInteger(next.value, DEFAULT_AGENT_PROBE_COUNT, 1, 100);
      index += next.consumed;
      continue;
    }
    if (token === '--probe-payload-size' || token.startsWith('--probe-payload-size=')) {
      const next = readOptionValue(args, index, '--probe-payload-size');
      options.probePayloadSize = normalizePositiveInteger(next.value, DEFAULT_AGENT_PROBE_PAYLOAD_SIZE, 0, 64 * 1024);
      index += next.consumed;
      continue;
    }
    if (token === '--token' || token.startsWith('--token=')) {
      const next = readOptionValue(args, index, '--token');
      options.token = nonEmptyString(next.value);
      index += next.consumed;
      continue;
    }
    if (token === '--token-file' || token.startsWith('--token-file=')) {
      const next = readOptionValue(args, index, '--token-file');
      options.tokenFile = resolveHomePath(next.value, deps.env || process.env || {});
      index += next.consumed;
      continue;
    }
    if (token === '--node-id' || token.startsWith('--node-id=')) {
      const next = readOptionValue(args, index, '--node-id');
      options.nodeId = normalizeNodeId(next.value);
      if (!options.nodeId) {
        const error = new Error('invalid_fabric_node_id');
        error.code = 'invalid_fabric_node_id';
        throw error;
      }
      index += next.consumed;
      continue;
    }
    if (token === '--status' || token.startsWith('--status=')) {
      const next = readOptionValue(args, index, '--status');
      options.status = nonEmptyString(next.value) || 'online';
      index += next.consumed;
      continue;
    }
    if (token === '--relay-status' || token.startsWith('--relay-status=')) {
      const next = readOptionValue(args, index, '--relay-status');
      options.relayStatus = nonEmptyString(next.value);
      index += next.consumed;
      continue;
    }
    if (token === '--transport' || token.startsWith('--transport=')) {
      const next = readOptionValue(args, index, '--transport');
      options.transports.push(parseTransportHeartbeat(next.value));
      index += next.consumed;
      continue;
    }
    if (token === '--probe-transport' || token.startsWith('--probe-transport=')) {
      const next = readOptionValue(args, index, '--probe-transport');
      options.probeTransports.push(parseProbeTransport(next.value));
      index += next.consumed;
      continue;
    }
    if (isFlag(token)) {
      const error = new Error(`unknown_option:${token}`);
      error.code = 'unknown_option';
      error.flag = token;
      throw error;
    }
    if (options.endpoint) {
      const error = new Error('too_many_fabric_registry_endpoints');
      error.code = 'too_many_fabric_registry_endpoints';
      throw error;
    }
    options.endpoint = normalizeEndpoint(token);
    index += 1;
  }

  if (!options.token && options.tokenFile) {
    options.token = readTokenFile(options.tokenFile, deps);
  }
  if (!options.token) {
    const error = new Error('missing_fabric_token');
    error.code = 'missing_fabric_token';
    throw error;
  }
  if (!options.endpoint) {
    const error = new Error('missing_fabric_registry_endpoint');
    error.code = 'missing_fabric_registry_endpoint';
    throw error;
  }
  if (!options.nodeId) {
    const error = new Error('invalid_fabric_node_id');
    error.code = 'invalid_fabric_node_id';
    throw error;
  }
  return options;
}

function parseProbeTransport(value) {
  const text = nonEmptyString(value);
  const [kindRaw, targetRaw] = text.includes('=') ? text.split(/=(.*)/, 2) : text.split(/:(.*)/, 2);
  const kind = parseTransportHeartbeat(`${kindRaw}=unknown`).kind;
  const target = nonEmptyString(targetRaw);
  if (!target) {
    const error = new Error('missing_probe_target');
    error.code = 'missing_probe_target';
    throw error;
  }
  return { kind, target };
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildHeartbeatOptions(options) {
  return {
    endpoint: options.endpoint,
    token: options.token,
    nodeId: options.nodeId,
    status: options.status,
    relayStatus: options.relayStatus,
    transports: options.transports,
    json: false
  };
}

function probeErrorCode(probe = {}) {
  if (probe.error) return nonEmptyString(probe.error).slice(0, 160);
  if (Array.isArray(probe.failures) && probe.failures.length > 0) {
    return nonEmptyString(probe.failures[0] && probe.failures[0].error).slice(0, 160);
  }
  if (probe.http && Number(probe.http.status)) return `http_${Number(probe.http.status)}`;
  if (probe.status) return nonEmptyString(probe.status).slice(0, 160);
  return '';
}

function transportHealthFromProbe(probe = {}) {
  if (probe.networkReachable === false || probe.reachable === false) return 'offline';
  if (probe.serviceHealthy === false) return 'degraded';
  if (probe.ok === false && Number(probe.successes || 0) > 0) return 'degraded';
  if (probe.ok === false) return 'offline';
  if (probe.ok === true) return 'online';
  if (probe.reachable || probe.networkReachable) return 'online';
  return 'unknown';
}

function sanitizeProbeResult(input = {}, probe = {}) {
  const result = {
    kind: input.kind,
    health: transportHealthFromProbe(probe),
    lastError: transportHealthFromProbe(probe) === 'online' ? '' : probeErrorCode(probe),
    durationMs: Number.isFinite(Number(probe.durationMs)) ? Number(probe.durationMs) : 0,
    status: nonEmptyString(probe.status)
  };
  if (probe.rttMs && typeof probe.rttMs === 'object') {
    result.rttMs = {
      min: Number(probe.rttMs.min || 0),
      p50: Number(probe.rttMs.p50 || 0),
      p95: Number(probe.rttMs.p95 || 0),
      max: Number(probe.rttMs.max || 0),
      avg: Number(probe.rttMs.avg || 0)
    };
  }
  if (Number.isFinite(Number(probe.successes))) result.successes = Number(probe.successes);
  if (Array.isArray(probe.failures)) result.failures = probe.failures.length;
  return result;
}

function mergeTransportHeartbeats(explicitTransports = [], measuredTransports = []) {
  const merged = new Map();
  explicitTransports.forEach((transport) => {
    merged.set(transport.kind, transport);
  });
  measuredTransports.forEach((transport) => {
    merged.set(transport.kind, {
      kind: transport.kind,
      health: transport.health,
      lastError: transport.lastError
    });
  });
  return Array.from(merged.values());
}

async function probeAgentTransports(options = {}, deps = {}) {
  const measured = [];
  for (const input of options.probeTransports) {
    const firstProbe = await runAgentTransportProbe(input, options, deps);
    measured.push(sanitizeProbeResult(input, firstProbe));
  }
  return measured;
}

function targetScheme(value) {
  const match = nonEmptyString(value).match(/^([a-z][a-z0-9+.-]*):\/\//i);
  return match ? match[1].toLowerCase() : '';
}

function firstEchoFailure(result = {}) {
  return Array.isArray(result.failures) && result.failures.length > 0
    ? result.failures[0] || {}
    : {};
}

function normalizeEchoProbeResult(result = {}, status) {
  const successes = Number(result.successes || 0);
  const failure = firstEchoFailure(result);
  return {
    ok: Boolean(result.ok),
    reachable: successes > 0 || Boolean(result.ok),
    networkReachable: successes > 0 || Boolean(result.ok),
    serviceHealthy: Boolean(result.ok),
    status: result.ok ? `${status}_pass` : `${status}_fail`,
    durationMs: Number(result.durationMs || 0),
    successes,
    failures: Array.isArray(result.failures) ? result.failures : [],
    error: result.ok ? '' : nonEmptyString(failure.error || 'echo_failed'),
    rttMs: result.rttMs || {}
  };
}

async function runAgentTransportProbe(input = {}, options = {}, deps = {}) {
  const scheme = targetScheme(input.target);
  if (scheme === 'ws' || scheme === 'wss') {
    const runner = deps.runFabricTransportEcho || runFabricTransportEcho;
    const result = await runner([
      input.target,
      '--timeout-ms',
      String(options.probeTimeoutMs),
      '--count',
      String(options.probeCount),
      '--payload-size',
      String(options.probePayloadSize),
      '--json'
    ], deps);
    return normalizeEchoProbeResult(result, 'ws_echo');
  }
  if (scheme === 'tcp') {
    const runner = deps.runFabricTransportTcpEcho || runFabricTransportTcpEcho;
    const result = await runner([
      input.target,
      '--timeout-ms',
      String(options.probeTimeoutMs),
      '--count',
      String(options.probeCount),
      '--payload-size',
      String(options.probePayloadSize),
      '--json'
    ], deps);
    return normalizeEchoProbeResult(result, 'tcp_echo');
  }

  const probeRunner = deps.runFabricTransportProbe || runFabricTransportProbe;
  const result = await probeRunner([
    input.target,
    '--timeout-ms',
    String(options.probeTimeoutMs),
    '--method',
    options.probeMethod,
    '--json'
  ], deps);
  return result && Array.isArray(result.probes) ? result.probes[0] || {} : {};
}

function sanitizeError(error) {
  return {
    code: String((error && error.code) || 'fabric_registry_agent_failed'),
    message: String((error && error.message) || error || 'fabric_registry_agent_failed'),
    status: error && error.status ? error.status : 0
  };
}

function countsFromResult(result = {}) {
  return result && result.result && result.result.registry
    ? result.result.registry.counts || {}
    : {};
}

async function runFabricRegistryAgent(rawArgs = [], deps = {}) {
  const options = parseFabricRegistryAgentArgs(rawArgs, deps);
  const runHeartbeat = deps.postFabricRegistryHeartbeat || postFabricRegistryHeartbeat;
  const sleep = deps.sleep || sleepMs;
  const onEvent = typeof deps.onEvent === 'function' ? deps.onEvent : null;
  const shouldStop = typeof deps.shouldStop === 'function' ? deps.shouldStop : null;
  let attempts = 0;
  let failures = 0;
  let lastResult = null;
  let lastError = null;
  let lastProbes = [];

  for (;;) {
    attempts += 1;
    try {
      lastProbes = await probeAgentTransports(options, deps);
      const heartbeatOptions = buildHeartbeatOptions({
        ...options,
        transports: mergeTransportHeartbeats(options.transports, lastProbes)
      });
      lastResult = await runHeartbeat(heartbeatOptions, deps);
      lastError = null;
      if (onEvent) {
        onEvent({
          type: 'heartbeat',
          ok: true,
          attempt: attempts,
          endpoint: options.endpoint,
          nodeId: options.nodeId,
          status: options.status,
          relayStatus: options.relayStatus,
          transports: heartbeatOptions.transports.length,
          probes: lastProbes,
          counts: countsFromResult(lastResult)
        });
      }
    } catch (error) {
      failures += 1;
      lastError = sanitizeError(error);
      if (onEvent) {
        onEvent({
          type: 'heartbeat_error',
          ok: false,
          attempt: attempts,
          endpoint: options.endpoint,
          nodeId: options.nodeId,
          error: lastError
        });
      }
    }

    const state = { attempts, failures, lastResult, lastError, lastProbes };
    if ((options.count > 0 && attempts >= options.count) || (shouldStop && shouldStop(state))) {
      break;
    }
    await sleep(options.intervalMs);
  }

  return {
    ok: failures === 0,
    json: options.json,
    endpoint: options.endpoint,
    nodeId: options.nodeId,
    status: options.status,
    relayStatus: options.relayStatus,
    transports: options.transports.length,
    probes: lastProbes,
    intervalMs: options.intervalMs,
    count: options.count,
    attempts,
    failures,
    lastResult,
    lastError
  };
}

function formatFabricRegistryAgentEvent(event = {}) {
  if (event.ok) {
    const counts = event.counts || {};
    const probes = Array.isArray(event.probes) && event.probes.length > 0
      ? ` probes=${event.probes.map((probe) => `${probe.kind}:${probe.health}`).join(',')}`
      : '';
    const countText = Object.keys(counts).length > 0
      ? ` nodes=${counts.nodes || 0} relayNodes=${counts.relayNodes || 0} transports=${counts.transports || 0} projects=${counts.projects || 0} runtimes=${counts.runtimes || 0}`
      : '';
    return `[aih fabric agent] heartbeat #${event.attempt || 0} node=${event.nodeId || ''} status=${event.status || ''} relay=${event.relayStatus || '-'} transports=${event.transports || 0}${probes}${countText}`;
  }
  const error = event.error || {};
  return `[aih fabric agent] heartbeat #${event.attempt || 0} node=${event.nodeId || ''} failed=${error.code || 'error'} message=${error.message || ''}`;
}

function formatFabricRegistryAgentReport(result = {}) {
  const lines = [];
  lines.push('AIH Fabric registry agent');
  lines.push(`  endpoint: ${result.endpoint || ''}`);
  lines.push(`  node: ${result.nodeId || ''}`);
  lines.push(`  interval_ms: ${Number(result.intervalMs || 0)}`);
  lines.push(`  attempts: ${Number(result.attempts || 0)}`);
  lines.push(`  failures: ${Number(result.failures || 0)}`);
  lines.push(`  status: ${result.ok ? 'ok' : 'degraded'}`);
  return lines.join('\n');
}

module.exports = {
  DEFAULT_AGENT_INTERVAL_MS,
  DEFAULT_AGENT_PROBE_COUNT,
  DEFAULT_AGENT_PROBE_PAYLOAD_SIZE,
  formatFabricRegistryAgentEvent,
  formatFabricRegistryAgentReport,
  hasJsonFlag,
  mergeTransportHeartbeats,
  parseProbeTransport,
  parseFabricRegistryAgentArgs,
  probeAgentTransports,
  readTokenFile,
  runAgentTransportProbe,
  runFabricRegistryAgent
};
