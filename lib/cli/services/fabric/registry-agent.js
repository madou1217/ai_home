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
const {
  loadServerRuntimeAccounts: defaultLoadServerRuntimeAccounts
} = require('../../../server/accounts');
const {
  summarizeAccountAvailability
} = require('../../../server/account-availability');
const {
  withAccountQueryListFns
} = require('../../../server/account-load-args');
const {
  resolveNativeCliPath
} = require('../../../runtime/native-cli-resolver');
const {
  readRegistryAgentManagementKey
} = require('./registry-agent-management-key-store');

const DEFAULT_AGENT_INTERVAL_MS = 30000;
const DEFAULT_AGENT_PROBE_COUNT = 1;
const DEFAULT_AGENT_PROBE_PAYLOAD_SIZE = 32;
const DEFAULT_RUNTIME_DIAGNOSTIC_PROVIDERS = Object.freeze(['codex', 'claude', 'agy', 'opencode']);

function hasJsonFlag(args = []) {
  return args.some((item) => {
    const token = nonEmptyString(item);
    return token === '--json';
  });
}

function parseFabricRegistryAgentArgs(rawArgs = [], deps = {}) {
  const args = Array.isArray(rawArgs) ? rawArgs.map((item) => String(item)) : [];
  const options = {
    endpoint: '',
    managementKey: nonEmptyString((deps.env || process.env || {}).AIH_MANAGEMENT_KEY),
    nodeId: '',
    status: 'online',
    relayStatus: '',
    transports: [],
    probeTransports: [],
    probeTimeoutMs: 5000,
    probeMethod: 'HEAD',
    probeCount: DEFAULT_AGENT_PROBE_COUNT,
    probePayloadSize: DEFAULT_AGENT_PROBE_PAYLOAD_SIZE,
    runtimeDiagnostics: false,
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
    if (token === '--runtime-diagnostics') {
      options.runtimeDiagnostics = true;
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
    if (token === '--management-key' || token.startsWith('--management-key=')) {
      const next = readOptionValue(args, index, '--management-key');
      options.managementKey = nonEmptyString(next.value);
      index += next.consumed;
      continue;
    }
    if (token === '--management-key-file' || token.startsWith('--management-key-file=')) {
      const error = new Error('fabric_agent_management_key_file_not_allowed');
      error.code = 'fabric_agent_management_key_file_not_allowed';
      throw error;
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
  if (!options.managementKey) {
    options.managementKey = readRegistryAgentManagementKey(options.nodeId, deps);
  }
  if (!options.managementKey) {
    const error = new Error('missing_management_key');
    error.code = 'missing_management_key';
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
    managementKey: options.managementKey,
    nodeId: options.nodeId,
    status: options.status,
    relayStatus: options.relayStatus,
    transports: options.transports,
    runtimeDiagnostics: Array.isArray(options.runtimeDiagnosticsPayload) ? options.runtimeDiagnosticsPayload : [],
    json: false
  };
}

function resolveExecutablePath(command, deps = {}) {
  const processObj = deps.processObj || process;
  const env = deps.env || processObj.env || process.env || {};
  const platform = processObj.platform || process.platform;
  return resolveNativeCliPath(command, {
    fs: deps.fs || fs,
    env,
    platform,
    cwd: deps.cwd,
    appRoot: deps.appRoot,
    runtimeToolsDir: deps.runtimeToolsDir,
    projectFallback: deps.projectFallback,
    spawnSyncImpl: deps.spawnSyncImpl
  });
}

function readyzUrl(endpoint) {
  return new URL('/readyz', normalizeEndpoint(endpoint)).toString();
}

async function fetchReadyzAccountCounts(endpoint, deps = {}) {
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    return { ok: false, accounts: {}, error: 'fetch_unavailable' };
  }
  try {
    const response = await fetchImpl(readyzUrl(endpoint), { method: 'GET' });
    const payload = await response.json().catch(() => ({}));
    const accounts = payload && typeof payload.accounts === 'object' && !Array.isArray(payload.accounts)
      ? payload.accounts
      : {};
    return {
      ok: response.ok,
      accounts,
      error: response.ok ? '' : `http_${response.status}`
    };
  } catch (error) {
    return {
      ok: false,
      accounts: {},
      error: nonEmptyString(error && error.code) || nonEmptyString(error && error.message) || 'readyz_unavailable'
    };
  }
}

function buildRuntimeDiagnostic(provider, commandPath, accountCounts, readyz) {
  const accountTotal = Number(accountCounts && accountCounts[provider]);
  const availability = accountCounts && accountCounts[provider] && typeof accountCounts[provider] === 'object'
    ? accountCounts[provider]
    : null;
  const total = availability
    ? Number(availability.total)
    : accountTotal;
  const source = availability
    ? nonEmptyString(availability.source) || 'runtime_accounts'
    : 'readyz';
  const accounts = {
    total: Number.isFinite(total) && total > 0 ? Math.floor(total) : 0,
    source,
    error: availability
      ? nonEmptyString(availability.error)
      : (readyz && readyz.ok ? '' : nonEmptyString(readyz && readyz.error))
  };
  if (availability) {
    accounts.available = Math.max(0, Math.floor(Number(availability.available) || 0));
    accounts.unavailable = Math.max(0, Math.floor(Number(availability.unavailable) || 0));
    accounts.reasons = Array.isArray(availability.reasons) ? availability.reasons : [];
  }
  return {
    provider,
    cli: {
      command: provider,
      available: Boolean(commandPath),
      path: commandPath || ''
    },
    accounts
  };
}

function resolveAccountStateIndex(deps = {}) {
  if (deps.accountStateIndex) return deps.accountStateIndex;
  if (typeof deps.getAccountStateIndex !== 'function') return null;
  try {
    return deps.getAccountStateIndex();
  } catch (_error) {
    return null;
  }
}

function endpointPort(endpoint) {
  try {
    const url = new URL(normalizeEndpoint(endpoint));
    if (url.port) return Number(url.port) || 0;
    if (url.protocol === 'https:') return 443;
    if (url.protocol === 'http:') return 80;
  } catch (_error) {}
  return 0;
}

function canLoadRuntimeAccounts(deps = {}) {
  return deps.fs
    && nonEmptyString(deps.aiHomeDir)
    && typeof deps.getProfileDir === 'function'
    && typeof deps.checkStatus === 'function';
}

function sanitizeAvailabilityReasons(reasons) {
  return (Array.isArray(reasons) ? reasons : []).map((item) => ({
    reason: nonEmptyString(item && item.reason).slice(0, 160),
    count: Math.max(0, Math.floor(Number(item && item.count) || 0)),
    sampleAccountRefs: (Array.isArray(item && item.sampleAccountRefs) ? item.sampleAccountRefs : [])
      .map((accountRef) => nonEmptyString(accountRef).slice(0, 64))
      .filter(Boolean)
      .slice(0, 5),
    ...(Number(item && item.retryAt) > 0 ? { retryAt: Math.floor(Number(item.retryAt)) } : {})
  })).filter((item) => item.reason);
}

function loadRuntimeAccountAvailability(options = {}, deps = {}) {
  if (!canLoadRuntimeAccounts(deps)) return null;
  const loadServerRuntimeAccounts = deps.loadServerRuntimeAccounts || defaultLoadServerRuntimeAccounts;
  if (typeof loadServerRuntimeAccounts !== 'function') return null;
  try {
    const accountsByProvider = loadServerRuntimeAccounts(withAccountQueryListFns({
      fs: deps.fs,
      aiHomeDir: deps.aiHomeDir,
      accountStateIndex: resolveAccountStateIndex(deps),
      accountStateService: deps.accountStateService,
      getProfileDir: deps.getProfileDir,
      checkStatus: deps.checkStatus,
      serverPort: endpointPort(options.endpoint)
    }, {
      accountQueryService: deps.accountQueryService,
      accountStateService: deps.accountStateService
    }));
    const out = {};
    DEFAULT_RUNTIME_DIAGNOSTIC_PROVIDERS.forEach((provider) => {
      const availability = summarizeAccountAvailability(accountsByProvider[provider] || [], { provider });
      out[provider] = {
        total: availability.total,
        available: availability.available,
        unavailable: availability.unavailable,
        reasons: sanitizeAvailabilityReasons(availability.reasons),
        source: 'runtime_accounts'
      };
    });
    return out;
  } catch (error) {
    const code = nonEmptyString(error && error.code) || nonEmptyString(error && error.message) || 'runtime_accounts_unavailable';
    const out = {};
    DEFAULT_RUNTIME_DIAGNOSTIC_PROVIDERS.forEach((provider) => {
      out[provider] = {
        total: 0,
        available: 0,
        unavailable: 0,
        reasons: [],
        source: 'runtime_accounts',
        error: code.slice(0, 160)
      };
    });
    return out;
  }
}

async function discoverRuntimeDiagnostics(options = {}, deps = {}) {
  if (!options.runtimeDiagnostics) return [];
  const readyz = await fetchReadyzAccountCounts(options.endpoint, deps);
  const runtimeAvailability = loadRuntimeAccountAvailability(options, deps);
  const accountFacts = runtimeAvailability || readyz.accounts;
  return DEFAULT_RUNTIME_DIAGNOSTIC_PROVIDERS.map((provider) => {
    return buildRuntimeDiagnostic(provider, resolveExecutablePath(provider, deps), accountFacts, readyz);
  });
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

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : null;
}

function nonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function normalizeProbeRttMetrics(value) {
  const source = value && typeof value === 'object' ? value : {};
  const rtt = {};
  ['min', 'p50', 'p95', 'max', 'avg', 'count'].forEach((key) => {
    const number = nonNegativeNumber(source[key]);
    if (number === null) return;
    rtt[key] = Math.floor(number);
  });
  return Object.keys(rtt).length > 0 ? rtt : null;
}

function countProbeFailures(probe = {}) {
  if (Array.isArray(probe.failures)) return probe.failures.length;
  return nonNegativeInteger(probe.failures);
}

function deriveProbeSampleCount(probe = {}, successes, failures, rttMs) {
  const explicit = nonNegativeInteger(probe.sampleCount);
  if (explicit !== null) return explicit;
  const rttCount = nonNegativeInteger(rttMs && rttMs.count);
  if (rttCount !== null) return rttCount;
  const total = Number(successes || 0) + Number(failures || 0);
  return total > 0 ? total : 0;
}

function deriveProbeSuccessRate(successes, sampleCount) {
  if (!sampleCount) return null;
  const rate = Number(successes || 0) / Number(sampleCount);
  if (!Number.isFinite(rate)) return null;
  return Math.max(0, Math.min(1, rate));
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
  const health = transportHealthFromProbe(probe);
  const rttMs = normalizeProbeRttMetrics(probe.rttMs);
  const successes = nonNegativeInteger(probe.successes);
  const failures = countProbeFailures(probe);
  const sampleCount = deriveProbeSampleCount(probe, successes, failures, rttMs);
  const successRate = deriveProbeSuccessRate(successes, sampleCount);
  const failureReason = health === 'online' ? '' : probeErrorCode(probe);
  const result = {
    kind: input.kind,
    health,
    lastError: health === 'online' ? '' : failureReason,
    durationMs: Number.isFinite(Number(probe.durationMs)) ? Number(probe.durationMs) : 0,
    status: nonEmptyString(probe.status)
  };
  if (rttMs) result.rttMs = rttMs;
  if (successes !== null) result.successes = successes;
  if (failures !== null) result.failures = failures;
  if (sampleCount > 0) result.sampleCount = sampleCount;
  if (successRate !== null) result.successRate = successRate;
  if (failureReason) result.failureReason = failureReason;
  return result;
}

function buildTransportMeasurement(transport = {}) {
  const measurement = {};
  [
    'status',
    'durationMs',
    'successes',
    'failures',
    'sampleCount',
    'successRate',
    'failureReason',
    'rttMs'
  ].forEach((key) => {
    if (transport[key] !== undefined && transport[key] !== null && transport[key] !== '') {
      measurement[key] = transport[key];
    }
  });
  return measurement;
}

function mergeTransportHeartbeats(explicitTransports = [], measuredTransports = []) {
  const merged = new Map();
  explicitTransports.forEach((transport) => {
    merged.set(transport.kind, transport);
  });
  measuredTransports.forEach((transport) => {
    const existing = merged.get(transport.kind) || {};
    merged.set(transport.kind, {
      kind: transport.kind,
      health: transport.health,
      lastError: transport.lastError,
      measurement: buildTransportMeasurement(transport),
      ...(existing.promotion ? { promotion: existing.promotion } : {})
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
      const runtimeDiagnostics = await discoverRuntimeDiagnostics(options, deps);
      const heartbeatOptions = buildHeartbeatOptions({
        ...options,
        transports: mergeTransportHeartbeats(options.transports, lastProbes),
        runtimeDiagnosticsPayload: runtimeDiagnostics
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
          runtimeDiagnostics: runtimeDiagnostics.length,
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
    runtimeDiagnostics: options.runtimeDiagnostics,
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
  DEFAULT_RUNTIME_DIAGNOSTIC_PROVIDERS,
  discoverRuntimeDiagnostics,
  formatFabricRegistryAgentEvent,
  formatFabricRegistryAgentReport,
  hasJsonFlag,
  mergeTransportHeartbeats,
  parseProbeTransport,
  parseFabricRegistryAgentArgs,
  probeAgentTransports,
  runAgentTransportProbe,
  runFabricRegistryAgent
};
