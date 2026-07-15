'use strict';

const {
  readRemoteRegistry,
  replaceRegistryCollections,
  writeRemoteRegistry,
  nowMs
} = require('./remote-registry-store');

const DEFAULT_NODE_CAPABILITIES = Object.freeze([
  'status',
  'metrics',
  'accounts',
  'models',
  'usage',
  'projects',
  'sessions'
]);

const DEFAULT_TRANSPORT_PREFERENCE = Object.freeze([
  'tailscale',
  'zerotier',
  'wireguard',
  'omr',
  'frp',
  'ssh',
  'direct',
  'relay'
]);

function normalizeId(value) {
  const id = String(value || '').trim().toLowerCase();
  return /^[a-z0-9][a-z0-9_.-]{1,63}$/.test(id) ? id : '';
}

function normalizeText(value, maxLength = 256) {
  const text = String(value == null ? '' : value).trim();
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function normalizeStringList(value, fallback = []) {
  const input = Array.isArray(value) ? value : fallback;
  return Array.from(new Set(input
    .map((item) => normalizeText(item, 64))
    .filter(Boolean)));
}

function buildDefaultAuthRef(nodeId) {
  return nodeId ? `remote-node/${nodeId}` : '';
}

function sanitizeRemoteNode(input = {}, previous = null) {
  const source = input && typeof input === 'object' ? input : {};
  const previousNode = previous && typeof previous === 'object' ? previous : {};
  const nodeId = normalizeId(source.id || previousNode.id);
  if (!nodeId) {
    const error = new Error('invalid_node_id');
    error.code = 'invalid_node_id';
    throw error;
  }
  const now = nowMs();
  return {
    id: nodeId,
    name: normalizeText(source.name || previousNode.name || nodeId, 120),
    role: normalizeText(source.role || previousNode.role || 'worker', 64),
    endpointPolicy: normalizeText(source.endpointPolicy || previousNode.endpointPolicy || 'auto', 32),
    preferredTransports: normalizeStringList(
      source.preferredTransports,
      previousNode.preferredTransports || DEFAULT_TRANSPORT_PREFERENCE
    ),
    capabilities: normalizeStringList(
      source.capabilities,
      previousNode.capabilities || DEFAULT_NODE_CAPABILITIES
    ),
    authRef: normalizeText(source.authRef || previousNode.authRef || buildDefaultAuthRef(nodeId), 160),
    fingerprint: normalizeText(source.fingerprint || previousNode.fingerprint || '', 160),
    tags: normalizeStringList(source.tags, previousNode.tags || []),
    disabled: Boolean(source.disabled === undefined ? previousNode.disabled : source.disabled),
    lastSeenAt: Number(source.lastSeenAt || previousNode.lastSeenAt || 0) || 0,
    createdAt: Number(previousNode.createdAt || source.createdAt || now) || now,
    updatedAt: now
  };
}

function listRemoteNodes(deps = {}) {
  return readRemoteRegistry(deps).nodes.map((node) => sanitizeRemoteNode(node, node));
}

function getRemoteNode(nodeId, deps = {}) {
  const id = normalizeId(nodeId);
  if (!id) return null;
  return listRemoteNodes(deps).find((node) => node.id === id) || null;
}

function upsertRemoteNode(input, deps = {}) {
  const registry = readRemoteRegistry(deps);
  const id = normalizeId(input && input.id);
  const existing = id ? registry.nodes.find((node) => normalizeId(node && node.id) === id) : null;
  const node = sanitizeRemoteNode(input, existing);
  const nodes = registry.nodes.filter((entry) => normalizeId(entry && entry.id) !== node.id);
  nodes.push(node);
  nodes.sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id)));
  writeRemoteRegistry(replaceRegistryCollections(registry, { nodes }), deps);
  return node;
}

module.exports = {
  DEFAULT_NODE_CAPABILITIES,
  DEFAULT_TRANSPORT_PREFERENCE,
  normalizeId,
  sanitizeRemoteNode,
  listRemoteNodes,
  getRemoteNode,
  upsertRemoteNode
};
