'use strict';

const {
  isFlag,
  nonEmptyString,
  readOptionValue
} = require('./option-parser');

const SUPPORTED_TRANSPORT_KINDS = new Set([
  'relay',
  'wss',
  'webrtc',
  'webtransport',
  'direct',
  'tailscale',
  'zerotier',
  'wireguard',
  'frp',
  'ssh',
  'omr',
  'mptcp'
]);

function normalizeNodeId(value) {
  const raw = nonEmptyString(value).toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/[^a-z0-9]+$/, '')
    .slice(0, 64);
  if (/^[a-z0-9][a-z0-9_.-]{1,63}$/.test(raw)) return raw;
  return '';
}

function normalizeEndpoint(value) {
  const raw = nonEmptyString(value).replace(/\/+$/, '');
  if (!raw) {
    const error = new Error('missing_fabric_registry_endpoint');
    error.code = 'missing_fabric_registry_endpoint';
    throw error;
  }
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('bad_protocol');
    url.hash = '';
    return url.toString().replace(/\/+$/, '');
  } catch (_error) {
    const error = new Error('invalid_fabric_registry_endpoint');
    error.code = 'invalid_fabric_registry_endpoint';
    error.endpoint = raw;
    throw error;
  }
}

function parseTransportHeartbeat(value) {
  const text = nonEmptyString(value);
  const [kindRaw, restRaw] = text.includes('=') ? text.split(/=(.*)/, 2) : text.split(/:(.*)/, 2);
  const kind = nonEmptyString(kindRaw).toLowerCase();
  if (!SUPPORTED_TRANSPORT_KINDS.has(kind)) {
    const error = new Error('invalid_fabric_transport');
    error.code = 'invalid_fabric_transport';
    error.transport = text;
    throw error;
  }
  const rest = nonEmptyString(restRaw);
  const [healthRaw, errorRaw] = rest.split(/,(.*)/, 2);
  return {
    kind,
    health: nonEmptyString(healthRaw) || 'unknown',
    lastError: nonEmptyString(errorRaw)
  };
}

function parseFabricRegistryHeartbeatArgs(rawArgs = [], deps = {}) {
  const args = Array.isArray(rawArgs) ? rawArgs.map((item) => String(item)) : [];
  const options = {
    endpoint: '',
    token: nonEmptyString((deps.env || process.env || {}).AIH_FABRIC_TOKEN),
    nodeId: '',
    status: 'online',
    relayStatus: '',
    transports: [],
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
    if (token === '--token' || token.startsWith('--token=')) {
      const next = readOptionValue(args, index, '--token');
      options.token = nonEmptyString(next.value);
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

function buildHeartbeatPayload(options) {
  return {
    node: {
      id: options.nodeId,
      status: options.status
    },
    relayNode: options.relayStatus ? { status: options.relayStatus } : undefined,
    transports: options.transports
  };
}

async function runFabricRegistryHeartbeat(rawArgs = [], deps = {}) {
  const options = parseFabricRegistryHeartbeatArgs(rawArgs, deps);
  return postFabricRegistryHeartbeat(options, deps);
}

async function postFabricRegistryHeartbeat(options = {}, deps = {}) {
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    const error = new Error('fetch_unavailable');
    error.code = 'fetch_unavailable';
    throw error;
  }
  const response = await fetchImpl(`${options.endpoint}/v0/fabric/registry/heartbeat`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${options.token}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify(buildHeartbeatPayload(options))
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.ok) {
    const error = new Error(String(payload.error || `http_${response.status}`));
    error.code = String(payload.error || 'fabric_registry_heartbeat_failed');
    error.status = response.status;
    throw error;
  }
  return {
    ok: true,
    json: options.json,
    endpoint: options.endpoint,
    nodeId: options.nodeId,
    status: options.status,
    relayStatus: options.relayStatus,
    transports: options.transports.length,
    result: payload.result
  };
}

function formatFabricRegistryHeartbeatReport(result = {}) {
  const lines = [];
  lines.push('AIH Fabric registry heartbeat');
  lines.push(`  endpoint: ${result.endpoint || ''}`);
  lines.push(`  node: ${result.nodeId || ''}`);
  lines.push(`  status: ${result.status || ''}`);
  lines.push(`  relay: ${result.relayStatus || '-'}`);
  lines.push(`  transports: ${Number(result.transports || 0)}`);
  lines.push('  result: touched');
  return lines.join('\n');
}

module.exports = {
  buildHeartbeatPayload,
  formatFabricRegistryHeartbeatReport,
  normalizeEndpoint,
  normalizeNodeId,
  parseFabricRegistryHeartbeatArgs,
  parseTransportHeartbeat,
  postFabricRegistryHeartbeat,
  runFabricRegistryHeartbeat
};
