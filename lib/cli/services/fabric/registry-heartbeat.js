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

function normalizePromotionKey(value) {
  return nonEmptyString(value).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function parsePromotionBoolean(value) {
  const text = nonEmptyString(value).toLowerCase();
  if (['1', 'true', 'yes', 'ready', 'remote-ready', 'promoted', 'enabled'].includes(text)) return true;
  if (['0', 'false', 'no', 'blocked', 'disabled'].includes(text)) return false;
  return null;
}

function setPromotionOption(promotion, key, value) {
  const normalized = normalizePromotionKey(key);
  if (!normalized) return false;
  if (normalized === 'promotion' || normalized === 'remoterequestready' || normalized === 'ready') {
    const parsed = parsePromotionBoolean(value);
    if (parsed !== null) promotion.remoteRequestReady = parsed;
    return true;
  }
  if (normalized === 'mode') {
    promotion.mode = nonEmptyString(value).slice(0, 64);
    return true;
  }
  if (normalized === 'evidence' || normalized === 'evidenceref') {
    promotion.evidenceRef = nonEmptyString(value).slice(0, 256);
    return true;
  }
  if (normalized === 'rttp95ms') {
    promotion.rttP95Ms = Math.max(0, Number(value) || 0);
    return true;
  }
  if (normalized === 'rpcp95ms') {
    promotion.rpcP95Ms = Math.max(0, Number(value) || 0);
    return true;
  }
  if (normalized === 'promotedat') {
    promotion.promotedAt = Math.max(0, Number(value) || 0);
    return true;
  }
  if (normalized === 'expiresat') {
    promotion.expiresAt = Math.max(0, Number(value) || 0);
    return true;
  }
  return false;
}

function parseTransportTail(parts = []) {
  const promotion = {};
  let lastError = '';
  parts.forEach((part) => {
    const item = nonEmptyString(part);
    if (!item) return;
    const eqIndex = item.indexOf('=');
    if (eqIndex > 0) {
      const key = item.slice(0, eqIndex);
      const value = item.slice(eqIndex + 1);
      if (setPromotionOption(promotion, key, value)) return;
    }
    if (!lastError) lastError = item;
  });
  return {
    lastError,
    promotion: Object.keys(promotion).length > 0 ? promotion : null
  };
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
  const [healthRaw, ...tail] = rest.split(',');
  const parsedTail = parseTransportTail(tail);
  const transport = {
    kind,
    health: nonEmptyString(healthRaw) || 'unknown',
    lastError: parsedTail.lastError
  };
  if (parsedTail.promotion) transport.promotion = parsedTail.promotion;
  return transport;
}

function appendPromotionOption(parts, key, value) {
  if (value === undefined || value === null || value === '') return;
  parts.push(`${key}=${value}`);
}

function formatTransportHeartbeat(transport = {}) {
  const kind = nonEmptyString(transport.kind);
  const health = nonEmptyString(transport.health || transport.status) || 'unknown';
  const parts = [`${kind}=${health}`];
  const lastError = nonEmptyString(transport.lastError);
  if (lastError) parts.push(lastError);
  const promotion = transport.promotion && typeof transport.promotion === 'object' ? transport.promotion : null;
  if (promotion) {
    appendPromotionOption(parts, 'remote-request-ready', promotion.remoteRequestReady === true ? 'true' : 'false');
    appendPromotionOption(parts, 'mode', promotion.mode);
    appendPromotionOption(parts, 'evidence-ref', promotion.evidenceRef);
    appendPromotionOption(parts, 'rtt-p95-ms', promotion.rttP95Ms);
    appendPromotionOption(parts, 'rpc-p95-ms', promotion.rpcP95Ms);
    appendPromotionOption(parts, 'promoted-at', promotion.promotedAt);
    appendPromotionOption(parts, 'expires-at', promotion.expiresAt);
  }
  return parts.join(',');
}

function formatPersistentTransportHeartbeat(transport = {}) {
  return formatTransportHeartbeat({
    ...transport,
    lastError: ''
  });
}

function parseFabricRegistryHeartbeatArgs(rawArgs = [], deps = {}) {
  const args = Array.isArray(rawArgs) ? rawArgs.map((item) => String(item)) : [];
  const options = {
    endpoint: '',
    managementKey: nonEmptyString((deps.env || process.env || {}).AIH_MANAGEMENT_KEY),
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
    if (token === '--management-key' || token.startsWith('--management-key=')) {
      const next = readOptionValue(args, index, '--management-key');
      options.managementKey = nonEmptyString(next.value);
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

  if (!options.managementKey) {
    const error = new Error('missing_management_key');
    error.code = 'missing_management_key';
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
  const payload = {
    node: {
      id: options.nodeId,
      status: options.status
    },
    relayNode: options.relayStatus ? { status: options.relayStatus } : undefined,
    transports: options.transports
  };
  if (Array.isArray(options.runtimeDiagnostics) && options.runtimeDiagnostics.length > 0) {
    payload.runtimeDiagnostics = options.runtimeDiagnostics;
  }
  return payload;
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
      authorization: `Bearer ${options.managementKey}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify(buildHeartbeatPayload(options)),
    signal: deps.signal
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
  formatPersistentTransportHeartbeat,
  formatTransportHeartbeat,
  formatFabricRegistryHeartbeatReport,
  normalizeEndpoint,
  normalizeNodeId,
  parseFabricRegistryHeartbeatArgs,
  parseTransportHeartbeat,
  postFabricRegistryHeartbeat,
  runFabricRegistryHeartbeat
};
