'use strict';

const {
  buildExitIdentity,
  buildNodeEntityId,
  normalizePort,
  normalizeProtocol,
  normalizeServer
} = require('./egress-entity-identity');
const { isAccountRef } = require('../account/public-account-ref');

const SELECTION_MODES = new Set(['auto', 'pinned']);
const POOL_SCOPE_KINDS = new Set(['all', 'groups', 'nodes']);
const POOL_STRATEGIES = new Set(['shared', 'sticky', 'session']);
const MAX_SCOPE_ITEMS = 500;

function contractError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function text(value) {
  return typeof value === 'string' ? value.trim() : String(value || '').trim();
}

function list(value) {
  const values = Array.isArray(value) ? value : [];
  return [...new Set(values.map((item) => {
    if (item && typeof item === 'object') {
      const value = item.nodeId || item.groupId || item.poolGroupId || item.id || item.identity;
      if (value === undefined) throw contractError('invalid_scope_list_entry');
      return text(value);
    }
    return text(item);
  }).filter(Boolean))].slice(0, MAX_SCOPE_ITEMS);
}

function isRuntimeNodeName(value) {
  return /^node-\d+$/i.test(text(value));
}

function normalizeSelectionMode(value) {
  return String(value || '').trim().toLowerCase() === 'pinned' ? 'pinned' : 'auto';
}

function normalizePoolScope(raw) {
  const source = raw && typeof raw === 'object' && raw.scope && typeof raw.scope === 'object'
    ? raw.scope
    : (raw && typeof raw === 'object' ? raw : {});
  const groups = list(source.groups || source.groupIds);
  const nodes = list(source.nodes || source.nodeIds);
  if (nodes.some(isRuntimeNodeName)) throw contractError('invalid_persistent_node_id');
  let kind = text(source.kind).toLowerCase();
  if (!POOL_SCOPE_KINDS.has(kind)) {
    kind = groups.length > 0 ? 'groups' : (nodes.length > 0 ? 'nodes' : 'all');
  }
  // An empty explicit allowlist cannot select anything. Preserve the old
  // store's fail-safe behavior by treating it as all nodes.
  if ((kind === 'groups' && groups.length === 0) || (kind === 'nodes' && nodes.length === 0)) kind = 'all';
  return {
    kind,
    groups: kind === 'groups' ? groups : [],
    nodes: kind === 'nodes' ? nodes : []
  };
}

function stableResourceId(raw, fields, code) {
  for (const field of fields) {
    const value = text(raw && raw[field]);
    if (value) return value;
  }
  throw contractError(code);
}

function normalizeNodeEntity(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw contractError('invalid_node_entity');
  const protocol = normalizeProtocol(raw.protocol);
  const server = normalizeServer(raw.server);
  const port = normalizePort(raw.port);
  if (!protocol || !server || !port) throw contractError('invalid_stable_node_fields');
  // Credential material is intentionally ignored: it is neither copied into
  // the display entity nor allowed to make a second identity after a round trip.
  const nodeId = buildNodeEntityId({ protocol, server, port });
  return {
    nodeId,
    protocol,
    server,
    port,
    exitIdentity: buildExitIdentity({ protocol, server, port }),
    name: text(raw.name || raw.label) || nodeId,
    location: raw.location && typeof raw.location === 'object' ? { ...raw.location } : null,
    source: text(raw.source || raw.subscriptionId),
    lifecycle: text(raw.lifecycle) || 'active',
    tags: list(raw.tags)
  };
}

function normalizePoolGroup(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw contractError('invalid_pool_group');
  const poolGroupId = stableResourceId(raw, ['poolGroupId', 'groupId', 'id'], 'invalid_pool_group_id');
  if (isRuntimeNodeName(poolGroupId)) throw contractError('invalid_persistent_pool_group_id');
  return {
    poolGroupId,
    name: text(raw.name || raw.label) || poolGroupId,
    poolIds: list(raw.poolIds || raw.pools),
    description: text(raw.description),
    enabled: raw.enabled !== false
  };
}

function normalizeProxyPool(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw contractError('invalid_proxy_pool');
  const poolId = stableResourceId(raw, ['poolId', 'id'], 'invalid_proxy_pool_id');
  const poolGroupId = text(raw.poolGroupId || raw.groupId);
  if (isRuntimeNodeName(poolId)) throw contractError('invalid_persistent_pool_id');
  const nodeIds = list(raw.nodeIds || raw.nodes);
  if (nodeIds.some(isRuntimeNodeName)) throw contractError('invalid_persistent_node_id');
  return {
    poolId,
    poolGroupId,
    name: text(raw.name || raw.label) || poolId,
    nodeIds,
    selectionModeDefault: normalizeSelectionMode(raw.selectionModeDefault),
    rotationPolicy: text(raw.rotationPolicy) || 'shared',
    healthPolicy: raw.healthPolicy && typeof raw.healthPolicy === 'object' ? { ...raw.healthPolicy } : null,
    upstreamCompatibilityPolicy: raw.upstreamCompatibilityPolicy && typeof raw.upstreamCompatibilityPolicy === 'object'
      ? { ...raw.upstreamCompatibilityPolicy }
      : null,
    enabled: raw.enabled !== false
  };
}

function normalizeAccountEgressAssignment(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw contractError('invalid_account_egress_assignment');
  const accountRef = text(raw.accountRef);
  if (!isAccountRef(accountRef)) throw contractError('invalid_account_ref');
  const selectionMode = normalizeSelectionMode(raw.selectionMode);
  const pinnedNodeId = text(raw.pinnedNodeId || raw.nodeId);
  if (selectionMode === 'pinned') {
    if (!pinnedNodeId) throw contractError('pinned_node_id_required');
    if (isRuntimeNodeName(pinnedNodeId)) throw contractError('invalid_persistent_node_id');
  }
  const strategy = POOL_STRATEGIES.has(text(raw.strategy).toLowerCase()) ? text(raw.strategy).toLowerCase() : 'shared';
  return {
    accountRef,
    poolGroupId: text(raw.poolGroupId),
    poolId: text(raw.poolId),
    selectionMode,
    ...(selectionMode === 'pinned' ? { pinnedNodeId } : {}),
    strategy,
    scope: normalizePoolScope(raw),
    fallbackPolicy: text(raw.fallbackPolicy) || 'none',
    updatedAt: Number.isFinite(Number(raw.updatedAt)) && Number(raw.updatedAt) > 0 ? Number(raw.updatedAt) : 0
  };
}

module.exports = {
  normalizeAccountEgressAssignment,
  normalizeNodeEntity,
  normalizePoolGroup,
  normalizePoolScope,
  normalizeProxyPool,
  normalizeSelectionMode,
  POOL_SCOPE_KINDS,
  POOL_STRATEGIES,
  SELECTION_MODES
};
