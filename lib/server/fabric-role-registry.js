'use strict';

const crypto = require('node:crypto');
const path = require('node:path');

const { normalizeId, upsertRemoteNode } = require('./remote/node-registry');
const {
  normalizeTransportKind,
  upsertRemoteTransport
} = require('./remote/transport-registry');

const FABRIC_REGISTRY_FILE = 'fabric-registry.json';
const FABRIC_REGISTRY_VERSION = 1;
const MAX_NETWORK_MEASUREMENTS = 1000;

const FABRIC_NODE_ROLES = Object.freeze(['client', 'server', 'node', 'relay-node']);
const FABRIC_RUNTIME_PROVIDERS = Object.freeze(['codex', 'gemini', 'claude', 'agy', 'opencode']);
const FABRIC_RUNTIME_MODES = Object.freeze(['tui', 'gui', 'api']);
const FABRIC_RELAY_CAPACITY_CLASSES = Object.freeze(['tiny', 'small', 'standard']);
const DEFAULT_LEGACY_RELAY_TRANSPORT_SCORE = 55;
const FABRIC_TRANSPORT_KINDS = Object.freeze([
  'wss',
  'webrtc',
  'webtransport',
  'direct',
  'relay',
  'tailscale',
  'zerotier',
  'wireguard',
  'frp',
  'ssh',
  'omr',
  'mptcp'
]);

function nowMs(deps = {}) {
  return typeof deps.now === 'function' ? Number(deps.now()) : Date.now();
}

function normalizeText(value, maxLength = 256) {
  const text = String(value == null ? '' : value).trim();
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function normalizeStringList(value, fallback = [], maxLength = 96) {
  const input = Array.isArray(value) ? value : fallback;
  return Array.from(new Set(input
    .map((item) => normalizeText(item, maxLength))
    .filter(Boolean)));
}

function stableHash(value, prefix = 'sha256') {
  const text = normalizeText(value, 4096);
  if (!text) return '';
  return `${prefix}:${crypto.createHash('sha256').update(text).digest('hex')}`;
}

function shortHash(value) {
  return stableHash(value, '').replace(/^:/, '').slice(0, 16);
}

function readJsonFile(fs, filePath) {
  try {
    if (!filePath || !fs || !fs.existsSync(filePath)) return null;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_error) {
    return null;
  }
}

function ensureDir(fs, dirPath) {
  if (!fs || !dirPath || typeof fs.mkdirSync !== 'function') return;
  fs.mkdirSync(dirPath, { recursive: true });
}

function getFabricRegistryPath(aiHomeDir) {
  const root = normalizeText(aiHomeDir, 2048);
  return root ? path.join(root, FABRIC_REGISTRY_FILE) : '';
}

function normalizeRegistry(input) {
  const source = input && typeof input === 'object' ? input : {};
  return {
    version: FABRIC_REGISTRY_VERSION,
    nodes: Array.isArray(source.nodes) ? source.nodes : [],
    relayNodes: Array.isArray(source.relayNodes) ? source.relayNodes : [],
    transports: Array.isArray(source.transports) ? source.transports : [],
    projects: Array.isArray(source.projects) ? source.projects : [],
    runtimes: Array.isArray(source.runtimes) ? source.runtimes : [],
    networkMeasurements: Array.isArray(source.networkMeasurements) ? source.networkMeasurements : []
  };
}

function readFabricRegistry(deps = {}) {
  return normalizeRegistry(readJsonFile(deps.fs, getFabricRegistryPath(deps.aiHomeDir)));
}

function writeFabricRegistry(registry, deps = {}) {
  const filePath = getFabricRegistryPath(deps.aiHomeDir);
  const normalized = normalizeRegistry(registry);
  if (!deps.fs || !filePath) return normalized;
  ensureDir(deps.fs, path.dirname(filePath));
  deps.fs.writeFileSync(filePath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  try {
    if (typeof deps.fs.chmodSync === 'function') deps.fs.chmodSync(filePath, 0o600);
  } catch (_error) {}
  return normalized;
}

function normalizeRoleList(value) {
  const roles = normalizeStringList(value, [], 64)
    .map((role) => role.toLowerCase())
    .filter((role) => FABRIC_NODE_ROLES.includes(role));
  return roles.length > 0 ? roles : ['node'];
}

function normalizeProvider(value) {
  const provider = normalizeText(value, 64).toLowerCase();
  return FABRIC_RUNTIME_PROVIDERS.includes(provider) ? provider : '';
}

function normalizeRuntimeMode(value) {
  const mode = normalizeText(value, 64).toLowerCase();
  return FABRIC_RUNTIME_MODES.includes(mode) ? mode : 'tui';
}

function normalizeCapacityClass(value) {
  const capacityClass = normalizeText(value, 64).toLowerCase();
  return FABRIC_RELAY_CAPACITY_CLASSES.includes(capacityClass) ? capacityClass : 'tiny';
}

function normalizeFabricTransportKind(value) {
  const kind = normalizeText(value, 64).toLowerCase();
  return FABRIC_TRANSPORT_KINDS.includes(kind) ? kind : '';
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function normalizePriority(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 100;
  return Math.max(0, Math.min(1000, Math.floor(number)));
}

function normalizeNonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}

function normalizeRatio(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.max(0, Math.min(1, number));
}

function normalizeRttMetrics(value) {
  const source = value && typeof value === 'object' ? value : {};
  const metrics = {};
  ['min', 'p50', 'p95', 'max', 'avg', 'count'].forEach((key) => {
    if (source[key] === undefined || source[key] === null || source[key] === '') return;
    metrics[key] = normalizeNonNegativeNumber(source[key]);
  });
  return Object.keys(metrics).length > 0 ? metrics : null;
}

function sanitizeTransportMeasurement(input = {}, deps = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const rttMs = normalizeRttMetrics(source.rttMs);
  const hasMeasurement = Boolean(
    normalizeText(source.status, 96)
      || source.durationMs !== undefined
      || source.successes !== undefined
      || source.failures !== undefined
      || source.sampleCount !== undefined
      || source.successRate !== undefined
      || normalizeText(source.failureReason, 160)
      || rttMs
  );
  if (!hasMeasurement) return null;
  const successRate = normalizeRatio(source.successRate);
  const failureReason = normalizeText(source.failureReason, 160);
  const measurement = {
    status: normalizeText(source.status, 96),
    durationMs: normalizeNonNegativeNumber(source.durationMs),
    successes: normalizeNonNegativeNumber(source.successes),
    failures: normalizeNonNegativeNumber(source.failures),
    measuredAt: numberOrZero(source.measuredAt) || nowMs(deps)
  };
  if (source.sampleCount !== undefined) measurement.sampleCount = normalizeNonNegativeNumber(source.sampleCount);
  if (successRate !== null) measurement.successRate = successRate;
  if (failureReason) measurement.failureReason = failureReason;
  if (rttMs) measurement.rttMs = rttMs;
  return measurement;
}

function sanitizeNetworkMeasurement(input = {}, node, transport, deps = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const measurement = sanitizeTransportMeasurement(source, deps);
  if (!measurement || !node || !transport) return null;
  const measuredAt = numberOrZero(measurement.measuredAt) || nowMs(deps);
  const id = normalizeId(source.id) || normalizeId(`nm-${shortHash([
    node.id,
    transport.id,
    measuredAt,
    measurement.status,
    measurement.durationMs,
    measurement.successes,
    measurement.failures,
    measurement.sampleCount,
    measurement.successRate,
    measurement.failureReason
  ].join(':'))}`);
  if (!id) return null;
  const entry = {
    id,
    nodeId: node.id,
    transportId: transport.id,
    transportKind: transport.kind,
    ownerType: transport.ownerType,
    ownerId: transport.ownerId,
    status: measurement.status,
    durationMs: measurement.durationMs,
    successes: measurement.successes,
    failures: measurement.failures,
    measuredAt,
    createdAt: numberOrZero(source.createdAt) || nowMs(deps)
  };
  if (measurement.sampleCount !== undefined) entry.sampleCount = measurement.sampleCount;
  if (measurement.successRate !== undefined) entry.successRate = measurement.successRate;
  if (measurement.failureReason) entry.failureReason = measurement.failureReason;
  if (measurement.rttMs) entry.rttMs = measurement.rttMs;
  return entry;
}

function appendNetworkMeasurements(registry, node, transports, deps = {}) {
  const current = Array.isArray(registry && registry.networkMeasurements)
    ? registry.networkMeasurements.slice()
    : [];
  transports.forEach((transport) => {
    if (!transport || !transport.measurement) return;
    const entry = sanitizeNetworkMeasurement(transport.measurement, node, transport, deps);
    if (!entry) return;
    const index = current.findIndex((item) => normalizeId(item && item.id) === entry.id);
    if (index >= 0) current[index] = entry;
    else current.push(entry);
  });
  return current
    .sort((a, b) => numberOrZero(a && a.measuredAt) - numberOrZero(b && b.measuredAt))
    .slice(-MAX_NETWORK_MEASUREMENTS);
}

function sanitizeFabricNode(input = {}, previous = null, deps = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const prior = previous && typeof previous === 'object' ? previous : {};
  const id = normalizeId(source.id || source.nodeId || prior.id);
  if (!id) {
    const error = new Error('invalid_fabric_node_id');
    error.code = 'invalid_fabric_node_id';
    throw error;
  }
  const roles = normalizeRoleList(source.roles || (source.role ? [source.role] : prior.roles));
  const rawFingerprint = source.machineFingerprint || source.fingerprint || '';
  const machineFingerprintHash = normalizeText(source.machineFingerprintHash || prior.machineFingerprintHash, 160)
    || stableHash(rawFingerprint);
  const now = nowMs(deps);
  return {
    id,
    name: normalizeText(source.name || prior.name || id, 120),
    roles,
    platform: normalizeText(source.platform || prior.platform, 64),
    arch: normalizeText(source.arch || prior.arch, 64),
    machineFingerprintHash,
    ownerDeviceId: normalizeId(source.ownerDeviceId || prior.ownerDeviceId),
    capabilities: normalizeStringList(source.capabilities, prior.capabilities || [], 96),
    status: normalizeText(source.status || prior.status || 'online', 32),
    tags: normalizeStringList(source.tags, prior.tags || [], 64),
    lastSeenAt: numberOrZero(source.lastSeenAt || now),
    createdAt: numberOrZero(prior.createdAt || source.createdAt || now),
    updatedAt: now
  };
}

function sanitizeFabricProject(input = {}, nodeId, deps = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const displayPath = normalizeText(source.displayPath || source.path, 2048);
  const pathHash = normalizeText(source.pathHash, 160) || stableHash(displayPath);
  const id = normalizeId(source.id) || normalizeId(`${nodeId}-p-${shortHash(pathHash || displayPath || source.name)}`);
  if (!id || !pathHash) return null;
  return {
    id,
    nodeId,
    pathHash,
    displayPath,
    name: normalizeText(source.name || displayPath.split(/[\\/]/).filter(Boolean).pop() || id, 120),
    vcs: normalizeText(source.vcs || '', 32),
    permissions: normalizeStringList(source.permissions, [], 64),
    lastOpenedAt: numberOrZero(source.lastOpenedAt),
    updatedAt: nowMs(deps)
  };
}

function sanitizeFabricRuntime(input = {}, nodeId, deps = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const provider = normalizeProvider(source.provider);
  if (!provider) return null;
  const mode = normalizeRuntimeMode(source.mode);
  const id = normalizeId(source.id) || normalizeId(`${nodeId}-${provider}-${mode}`);
  if (!id) return null;
  return {
    id,
    nodeId,
    provider,
    mode,
    version: normalizeText(source.version || '', 120),
    capabilities: normalizeStringList(source.capabilities, [], 96),
    status: normalizeText(source.status || 'available', 32),
    updatedAt: nowMs(deps)
  };
}

function sanitizeFabricRelayNode(input = {}, node, deps = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const enabled = source.enabled === undefined ? node.roles.includes('relay-node') : Boolean(source.enabled);
  const id = normalizeId(source.id) || normalizeId(`${node.id}-relay`);
  if (!id) return null;
  return {
    id,
    nodeId: node.id,
    enabled,
    capacityClass: normalizeCapacityClass(source.capacityClass),
    bandwidthLimitKbps: numberOrZero(source.bandwidthLimitKbps),
    allowedScopes: normalizeStringList(source.allowedScopes, [], 96),
    status: normalizeText(source.status || (enabled ? 'online' : 'disabled'), 32),
    lastMeasuredAt: numberOrZero(source.lastMeasuredAt || nowMs(deps)),
    updatedAt: nowMs(deps)
  };
}

function defaultRelayTransport(nodeId) {
  return {
    id: `${nodeId}-relay`,
    kind: 'relay',
    endpoint: `relay://${nodeId}`,
    health: 'unknown',
    priority: 100
  };
}

function sanitizeFabricTransport(input = {}, node, deps = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const kind = normalizeFabricTransportKind(source.kind || 'relay');
  if (!kind) return null;
  const ownerType = normalizeText(source.ownerType || (kind === 'relay' ? 'relay-node' : 'node'), 64);
  const ownerId = normalizeId(source.ownerId || (ownerType === 'relay-node' ? `${node.id}-relay` : node.id));
  const id = normalizeId(source.id) || normalizeId(`${node.id}-${kind}`);
  if (!id || !ownerId) return null;
  const endpoint = normalizeText(source.endpoint || (kind === 'relay' ? `relay://${node.id}` : ''), 2048).replace(/\/+$/, '');
  const transport = {
    id,
    nodeId: node.id,
    ownerType,
    ownerId,
    kind,
    endpoint,
    priority: normalizePriority(source.priority),
    health: normalizeText(source.health || source.status || 'unknown', 32),
    lastError: normalizeText(source.lastError || '', 512),
    lastSeenAt: numberOrZero(source.lastSeenAt || nowMs(deps)),
    provider: normalizeText(source.provider || (kind === 'relay' ? 'aih-relay' : kind), 64),
    routeRole: normalizeText(source.routeRole || 'data-plane', 64),
    trustLevel: normalizeText(source.trustLevel || (kind === 'relay' ? 'managed' : 'manual'), 64),
    updatedAt: nowMs(deps)
  };
  const measurement = sanitizeTransportMeasurement(source.measurement || source, deps);
  if (measurement) transport.measurement = measurement;
  return transport;
}

function mergeWithoutNode(entries, nodeId) {
  return entries.filter((entry) => normalizeId(entry && entry.nodeId) !== nodeId);
}

function replaceOrAppend(entries, updated, matchFn) {
  let replaced = false;
  const next = entries.map((entry) => {
    if (!matchFn(entry)) return entry;
    replaced = true;
    return updated;
  });
  return replaced ? next : next.concat(updated);
}

function findNodeEntry(entries, nodeId) {
  const id = normalizeId(nodeId);
  return (Array.isArray(entries) ? entries : [])
    .find((entry) => normalizeId(entry && entry.id) === id) || null;
}

function findNodeTransport(transports, nodeId, input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const wantedId = normalizeId(source.id);
  const wantedKind = normalizeFabricTransportKind(source.kind);
  return (Array.isArray(transports) ? transports : []).find((entry) => {
    if (normalizeId(entry && entry.nodeId) !== nodeId) return false;
    if (wantedId && normalizeId(entry && entry.id) === wantedId) return true;
    return wantedKind && normalizeText(entry && entry.kind, 64).toLowerCase() === wantedKind;
  }) || null;
}

function legacyTransportStatusFromFabricHealth(value) {
  const health = normalizeText(value, 32).toLowerCase();
  if (health === 'online' || health === 'up' || health === 'healthy') return 'up';
  if (health === 'offline' || health === 'down' || health === 'failed' || health === 'unhealthy') return 'down';
  if (health === 'degraded' || health === 'warning') return 'degraded';
  return health || 'unknown';
}

function legacyTransportScoreFromFabricTransport(transport, legacyStatus) {
  const priority = Math.max(0, Math.min(100, Number(transport && transport.priority) || 0));
  const priorityScore = 100 - priority;
  if (
    normalizeText(transport && transport.kind, 64).toLowerCase() === 'relay'
    && (legacyStatus === 'up' || legacyStatus === 'degraded')
  ) {
    return Math.max(DEFAULT_LEGACY_RELAY_TRANSPORT_SCORE, priorityScore);
  }
  return priorityScore;
}

function mirrorLegacyNode(node, transports, deps = {}) {
  const legacyRole = node.roles.includes('relay-node') ? 'relay-node' : 'node';
  const preferredTransports = transports.map((transport) => transport.kind);
  upsertRemoteNode({
    id: node.id,
    name: node.name,
    role: legacyRole,
    preferredTransports: preferredTransports.length > 0 ? preferredTransports : ['relay'],
    capabilities: node.capabilities,
    fingerprint: node.machineFingerprintHash,
    tags: [
      ...node.tags,
      ...node.roles.map((role) => `role:${role}`)
    ],
    lastSeenAt: node.lastSeenAt
  }, deps);

  transports.forEach((transport) => {
    if (!normalizeTransportKind(transport.kind)) return;
    const legacyStatus = legacyTransportStatusFromFabricHealth(transport.health);
    upsertRemoteTransport({
      id: transport.id,
      nodeId: node.id,
      kind: transport.kind,
      endpoint: transport.endpoint,
      status: legacyStatus,
      score: legacyTransportScoreFromFabricTransport(transport, legacyStatus),
      lastError: transport.lastError,
      provider: transport.provider,
      routeRole: transport.routeRole,
      trustLevel: transport.trustLevel
    }, deps);
  });
}

function serializeFabricRegistry(registry) {
  const normalized = normalizeRegistry(registry);
  return {
    ...normalized,
    counts: {
      nodes: normalized.nodes.length,
      relayNodes: normalized.relayNodes.length,
      transports: normalized.transports.length,
      projects: normalized.projects.length,
      runtimes: normalized.runtimes.length
    }
  };
}

function registerFabricNode(input = {}, deps = {}) {
  const payload = input && typeof input === 'object' ? input : {};
  const nodeInput = payload.node && typeof payload.node === 'object' ? payload.node : payload;
  const registry = readFabricRegistry(deps);
  const existing = registry.nodes.find((entry) => normalizeId(entry && entry.id) === normalizeId(nodeInput.id || nodeInput.nodeId));
  const node = sanitizeFabricNode(nodeInput, existing, deps);
  const projectInputs = Array.isArray(payload.projects) ? payload.projects : [];
  const runtimeInputs = Array.isArray(payload.runtimes) ? payload.runtimes : [];
  const relayInput = payload.relayNode || payload.relay || {};
  const transportInputs = Array.isArray(payload.transports) ? payload.transports.slice() : [];
  if (node.roles.includes('relay-node') && !transportInputs.some((transport) => normalizeFabricTransportKind(transport && transport.kind) === 'relay')) {
    transportInputs.push(defaultRelayTransport(node.id));
  }

  const projects = projectInputs
    .map((project) => sanitizeFabricProject(project, node.id, deps))
    .filter(Boolean);
  const runtimes = runtimeInputs
    .map((runtime) => sanitizeFabricRuntime(runtime, node.id, deps))
    .filter(Boolean);
  const relayNode = node.roles.includes('relay-node') || relayInput.enabled !== undefined
    ? sanitizeFabricRelayNode(relayInput, node, deps)
    : null;
  const transports = transportInputs
    .map((transport) => sanitizeFabricTransport(transport, node, deps))
    .filter(Boolean);

  const next = normalizeRegistry({
    ...registry,
    nodes: registry.nodes.filter((entry) => normalizeId(entry && entry.id) !== node.id).concat(node)
      .sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id))),
    relayNodes: mergeWithoutNode(registry.relayNodes, node.id).concat(relayNode ? [relayNode] : []),
    transports: mergeWithoutNode(registry.transports, node.id).concat(transports),
    projects: mergeWithoutNode(registry.projects, node.id).concat(projects),
    runtimes: mergeWithoutNode(registry.runtimes, node.id).concat(runtimes),
    networkMeasurements: appendNetworkMeasurements(registry, node, transports, deps)
  });
  writeFabricRegistry(next, deps);
  mirrorLegacyNode(node, transports, deps);

  return {
    node,
    relayNode,
    transports,
    projects,
    runtimes,
    registry: serializeFabricRegistry(next)
  };
}

function heartbeatFabricNode(input = {}, deps = {}) {
  const payload = input && typeof input === 'object' ? input : {};
  const nodeInput = payload.node && typeof payload.node === 'object' ? payload.node : payload;
  const nodeId = normalizeId(nodeInput.id || nodeInput.nodeId || payload.nodeId || payload.id);
  if (!nodeId) {
    const error = new Error('invalid_fabric_node_id');
    error.code = 'invalid_fabric_node_id';
    throw error;
  }

  const registry = readFabricRegistry(deps);
  const existing = findNodeEntry(registry.nodes, nodeId);
  if (!existing) {
    const error = new Error('fabric_node_not_found');
    error.code = 'fabric_node_not_found';
    throw error;
  }

  const ownerDeviceId = normalizeId(deps.ownerDeviceId || payload.ownerDeviceId);
  if (existing.ownerDeviceId && ownerDeviceId && existing.ownerDeviceId !== ownerDeviceId) {
    const error = new Error('forbidden_fabric_node_owner');
    error.code = 'forbidden_fabric_node_owner';
    throw error;
  }

  const now = nowMs(deps);
  const node = sanitizeFabricNode({
    ...existing,
    ...nodeInput,
    id: existing.id,
    ownerDeviceId: existing.ownerDeviceId,
    lastSeenAt: numberOrZero(nodeInput.lastSeenAt) || now,
    status: normalizeText(nodeInput.status || payload.status || 'online', 32)
  }, existing, deps);

  const existingRelay = registry.relayNodes.find((entry) => normalizeId(entry && entry.nodeId) === node.id) || null;
  const relayInput = payload.relayNode || payload.relay || null;
  const relayNode = existingRelay || relayInput
    ? sanitizeFabricRelayNode({
        ...(existingRelay || {}),
        ...(relayInput && typeof relayInput === 'object' ? relayInput : {}),
        lastMeasuredAt: numberOrZero(relayInput && relayInput.lastMeasuredAt) || now,
        status: normalizeText(
          (relayInput && relayInput.status) || payload.relayStatus || (existingRelay && existingRelay.status) || 'online',
          32
        )
      }, node, deps)
    : null;

  const nodeTransports = registry.transports.filter((entry) => normalizeId(entry && entry.nodeId) === node.id);
  const transportInputs = Array.isArray(payload.transports) ? payload.transports : [];
  let updatedTransports = nodeTransports.slice();
  transportInputs.forEach((transportInput) => {
    const source = transportInput && typeof transportInput === 'object' ? transportInput : {};
    const existingTransport = findNodeTransport(updatedTransports, node.id, source);
    const transport = sanitizeFabricTransport({
      ...(existingTransport || {}),
      ...source,
      id: source.id || (existingTransport && existingTransport.id),
      kind: source.kind || (existingTransport && existingTransport.kind),
      lastSeenAt: numberOrZero(source.lastSeenAt) || now
    }, node, deps);
    if (!transport) return;
    updatedTransports = replaceOrAppend(
      updatedTransports,
      transport,
      (entry) => normalizeId(entry && entry.id) === transport.id
    );
  });

  const next = normalizeRegistry({
    ...registry,
    nodes: replaceOrAppend(
      registry.nodes,
      node,
      (entry) => normalizeId(entry && entry.id) === node.id
    ).sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id))),
    relayNodes: relayNode
      ? replaceOrAppend(
          registry.relayNodes,
          relayNode,
          (entry) => normalizeId(entry && entry.nodeId) === node.id
        )
      : registry.relayNodes,
    transports: mergeWithoutNode(registry.transports, node.id).concat(updatedTransports),
    projects: registry.projects,
    runtimes: registry.runtimes,
    networkMeasurements: appendNetworkMeasurements(registry, node, updatedTransports, deps)
  });
  writeFabricRegistry(next, deps);
  mirrorLegacyNode(node, updatedTransports, deps);

  return {
    node,
    relayNode,
    transports: updatedTransports,
    registry: serializeFabricRegistry(next)
  };
}

function listFabricRegistry(deps = {}) {
  return serializeFabricRegistry(readFabricRegistry(deps));
}

module.exports = {
  FABRIC_REGISTRY_FILE,
  FABRIC_REGISTRY_VERSION,
  getFabricRegistryPath,
  heartbeatFabricNode,
  listFabricRegistry,
  readFabricRegistry,
  registerFabricNode,
  sanitizeFabricNode,
  sanitizeFabricProject,
  sanitizeFabricRuntime,
  sanitizeFabricTransport,
  writeFabricRegistry
};
