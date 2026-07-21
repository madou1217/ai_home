'use strict';

const os = require('node:os');
const path = require('node:path');

const {
  isFlag,
  nonEmptyString,
  normalizePositiveInteger,
  readOptionValue
} = require('./option-parser');

const SUPPORTED_ROLES = new Set(['client', 'server', 'node', 'relay-node']);
const SUPPORTED_RUNTIMES = new Set(['codex', 'gemini', 'claude', 'agy', 'opencode']);
const SUPPORTED_RUNTIME_MODES = new Set(['tui', 'gui', 'api']);
const DEFAULT_REMOTE_MANAGEMENT_CAPABILITIES = Object.freeze(['status', 'metrics', 'accounts', 'models', 'usage']);
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

function normalizeNodeId(value, fallback = '') {
  const raw = nonEmptyString(value || fallback).toLowerCase()
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

function normalizeRole(value) {
  const role = nonEmptyString(value).toLowerCase();
  if (SUPPORTED_ROLES.has(role)) return role;
  const error = new Error('invalid_fabric_role');
  error.code = 'invalid_fabric_role';
  error.role = role;
  throw error;
}

function parseRuntime(value) {
  const text = nonEmptyString(value);
  const [providerRaw, modeRaw, versionRaw] = text.split(':');
  const provider = nonEmptyString(providerRaw).toLowerCase();
  const mode = nonEmptyString(modeRaw || 'tui').toLowerCase();
  if (!SUPPORTED_RUNTIMES.has(provider) || !SUPPORTED_RUNTIME_MODES.has(mode)) {
    const error = new Error('invalid_fabric_runtime');
    error.code = 'invalid_fabric_runtime';
    error.runtime = text;
    throw error;
  }
  return {
    provider,
    mode,
    version: nonEmptyString(versionRaw)
  };
}

function runtimeKey(runtime) {
  return `${nonEmptyString(runtime && runtime.provider).toLowerCase()}:${nonEmptyString(runtime && runtime.mode).toLowerCase()}`;
}

function mergeRuntimeSnapshots(explicitRuntimes = [], discoveredRuntimes = []) {
  const seen = new Set();
  const out = [];
  for (const runtime of [...explicitRuntimes, ...discoveredRuntimes]) {
    const key = runtimeKey(runtime);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(runtime);
  }
  return out;
}

function deriveRuntimeSnapshotsFromAccounts(accounts = []) {
  const groups = new Map();
  for (const account of Array.isArray(accounts) ? accounts : []) {
    const provider = nonEmptyString(account && account.provider).toLowerCase();
    if (!SUPPORTED_RUNTIMES.has(provider)) continue;
    const current = groups.get(provider) || { total: 0, schedulable: 0 };
    current.total += 1;
    const accountStatus = nonEmptyString(account && account.status).toLowerCase();
    const runtimeStatus = nonEmptyString(account && account.runtimeStatus).toLowerCase();
    const schedulableStatus = nonEmptyString(account && account.schedulableStatus).toLowerCase();
    if (
      accountStatus !== 'down'
      && runtimeStatus !== 'auth_invalid'
      && (!schedulableStatus || schedulableStatus === 'schedulable')
    ) {
      current.schedulable += 1;
    }
    groups.set(provider, current);
  }

  return Array.from(SUPPORTED_RUNTIMES)
    .filter((provider) => groups.has(provider))
    .map((provider) => {
      const group = groups.get(provider);
      return {
        provider,
        mode: 'api',
        version: '',
        capabilities: [
          `accounts:${group.total}`,
          `schedulable:${group.schedulable}`
        ],
        status: group.schedulable > 0 ? 'available' : 'degraded'
      };
    });
}

async function fetchServerRuntimeSnapshots(options, fetchImpl) {
  const endpoint = normalizeEndpoint(options.fromServerEndpoint || options.endpoint);
  const headers = {};
  if (options.managementKey) headers.authorization = `Bearer ${options.managementKey}`;
  const response = await fetchImpl(`${endpoint}/v0/management/accounts`, { headers });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.ok || !Array.isArray(payload.accounts)) {
    const error = new Error(String(payload.error || `http_${response.status}`));
    error.code = 'fabric_from_server_accounts_failed';
    error.status = response.status;
    throw error;
  }
  const runtimes = deriveRuntimeSnapshotsFromAccounts(payload.accounts);
  return {
    endpoint,
    accounts: payload.accounts.length,
    runtimes,
    providers: Array.from(new Set(runtimes.map((runtime) => runtime.provider))).sort()
  };
}

function parseTransport(value, nodeId) {
  const text = nonEmptyString(value);
  const [kindRaw, endpointRaw] = text.includes('=') ? text.split(/=(.*)/, 2) : [text, ''];
  const kind = nonEmptyString(kindRaw).toLowerCase();
  if (!SUPPORTED_TRANSPORT_KINDS.has(kind)) {
    const error = new Error('invalid_fabric_transport');
    error.code = 'invalid_fabric_transport';
    error.transport = text;
    throw error;
  }
  return {
    id: normalizeNodeId(`${nodeId}-${kind}`),
    kind,
    endpoint: nonEmptyString(endpointRaw) || (kind === 'relay' ? `relay://${nodeId}` : '')
  };
}

function buildProject(pathValue, deps = {}) {
  const cwd = typeof deps.cwd === 'function' ? deps.cwd() : process.cwd();
  const absolutePath = path.resolve(cwd, nonEmptyString(pathValue) || cwd);
  return {
    path: absolutePath,
    name: path.basename(absolutePath),
    vcs: ''
  };
}

function defaultNodeId(deps = {}) {
  const hostname = typeof deps.hostname === 'function' ? deps.hostname() : os.hostname();
  return normalizeNodeId(hostname, 'aih-node') || 'aih-node';
}

function parseFabricRegistryPublishArgs(rawArgs = [], deps = {}) {
  const args = Array.isArray(rawArgs) ? rawArgs.map((item) => String(item)) : [];
  const nodeId = { value: '' };
  const options = {
    endpoint: '',
    nodeId,
    name: '',
    roles: ['node'],
    platform: os.platform(),
    arch: os.arch(),
    fromServer: false,
    fromServerEndpoint: '',
    managementKey: nonEmptyString((deps.env || process.env || {}).AIH_MANAGEMENT_KEY),
    relayNode: null,
    transports: [],
    projects: [],
    runtimes: [],
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
    if (token === '--from-server') {
      options.fromServer = true;
      index += 1;
      continue;
    }
    if (token === '--from-server-url' || token.startsWith('--from-server-url=')) {
      const next = readOptionValue(args, index, '--from-server-url');
      options.fromServer = true;
      options.fromServerEndpoint = normalizeEndpoint(next.value);
      index += next.consumed;
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
      nodeId.value = normalizeNodeId(next.value);
      if (!nodeId.value) {
        const error = new Error('invalid_fabric_node_id');
        error.code = 'invalid_fabric_node_id';
        throw error;
      }
      index += next.consumed;
      continue;
    }
    if (token === '--name' || token.startsWith('--name=')) {
      const next = readOptionValue(args, index, '--name');
      options.name = nonEmptyString(next.value);
      index += next.consumed;
      continue;
    }
    if (token === '--role' || token.startsWith('--role=')) {
      const next = readOptionValue(args, index, '--role');
      options.roles.push(normalizeRole(next.value));
      index += next.consumed;
      continue;
    }
    if (token === '--relay-node') {
      options.roles.push('relay-node');
      options.relayNode = options.relayNode || { enabled: true, capacityClass: 'tiny', bandwidthLimitKbps: 0 };
      index += 1;
      continue;
    }
    if (token === '--bandwidth-kbps' || token.startsWith('--bandwidth-kbps=')) {
      const next = readOptionValue(args, index, '--bandwidth-kbps');
      options.relayNode = options.relayNode || { enabled: true, capacityClass: 'tiny', bandwidthLimitKbps: 0 };
      options.relayNode.bandwidthLimitKbps = normalizePositiveInteger(next.value, 0, 0, 100000000);
      index += next.consumed;
      continue;
    }
    if (token === '--project' || token.startsWith('--project=')) {
      const next = readOptionValue(args, index, '--project');
      options.projects.push(buildProject(next.value, deps));
      index += next.consumed;
      continue;
    }
    if (token === '--runtime' || token.startsWith('--runtime=')) {
      const next = readOptionValue(args, index, '--runtime');
      options.runtimes.push(parseRuntime(next.value));
      index += next.consumed;
      continue;
    }
    if (token === '--transport' || token.startsWith('--transport=')) {
      const next = readOptionValue(args, index, '--transport');
      options.transports.push({ raw: nonEmptyString(next.value) });
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

  options.nodeId = nodeId.value || defaultNodeId(deps);
  options.name = options.name || options.nodeId;
  options.roles = Array.from(new Set(options.roles.map(normalizeRole)));
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
  if (options.projects.length === 0) options.projects.push(buildProject('', deps));
  if (options.roles.includes('relay-node') && options.transports.length === 0) {
    options.transports.push({ raw: 'relay' });
  }
  options.transports = options.transports.map((transport) => parseTransport(transport.raw, options.nodeId));
  return options;
}

function buildPublishPayload(options) {
  return {
    node: {
      id: options.nodeId,
      name: options.name,
      roles: options.roles,
      platform: options.platform,
      arch: options.arch,
      capabilities: [
        ...DEFAULT_REMOTE_MANAGEMENT_CAPABILITIES,
        ...(options.projects.length > 0 ? ['projects'] : []),
        ...(options.runtimes.length > 0 ? ['runtimes', 'sessions'] : [])
      ]
    },
    relayNode: options.relayNode || undefined,
    transports: options.transports,
    projects: options.projects,
    runtimes: options.runtimes
  };
}

async function runFabricRegistryPublish(rawArgs = [], deps = {}) {
  const options = parseFabricRegistryPublishArgs(rawArgs, deps);
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    const error = new Error('fetch_unavailable');
    error.code = 'fetch_unavailable';
    throw error;
  }
  let fromServer = null;
  if (options.fromServer) {
    fromServer = await fetchServerRuntimeSnapshots(options, fetchImpl);
    options.runtimes = mergeRuntimeSnapshots(options.runtimes, fromServer.runtimes);
  }
  const response = await fetchImpl(`${options.endpoint}/v0/fabric/registry/nodes`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${options.managementKey}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify(buildPublishPayload(options))
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.ok) {
    const error = new Error(String(payload.error || `http_${response.status}`));
    error.code = String(payload.error || 'fabric_registry_publish_failed');
    error.status = response.status;
    throw error;
  }
  return {
    ok: true,
    json: options.json,
    endpoint: options.endpoint,
    nodeId: options.nodeId,
    roles: options.roles,
    projects: options.projects.length,
    runtimes: options.runtimes.length,
    transports: options.transports.length,
    fromServer,
    result: payload.result
  };
}

function formatFabricRegistryPublishReport(result = {}) {
  const lines = [];
  lines.push('AIH Fabric registry publish');
  lines.push(`  endpoint: ${result.endpoint || ''}`);
  lines.push(`  node: ${result.nodeId || ''}`);
  lines.push(`  roles: ${(result.roles || []).join(', ') || '-'}`);
  lines.push(`  projects: ${Number(result.projects || 0)}`);
  lines.push(`  runtimes: ${Number(result.runtimes || 0)}`);
  lines.push(`  transports: ${Number(result.transports || 0)}`);
  lines.push('  status: registered');
  return lines.join('\n');
}

module.exports = {
  buildPublishPayload,
  deriveRuntimeSnapshotsFromAccounts,
  fetchServerRuntimeSnapshots,
  formatFabricRegistryPublishReport,
  mergeRuntimeSnapshots,
  parseFabricRegistryPublishArgs,
  runFabricRegistryPublish
};
