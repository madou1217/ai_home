'use strict';

// Persistent identity maps for the egress domain.  Every record is stored
// under its stable identity, rather than in one account-shaped document.  The
// old account egress keys are deliberately left alone so this store can be
// introduced while the compatibility readers are still in use.

const {
  deleteJsonValue,
  readJsonValuesByPrefix,
  writeJsonValue
} = require('./app-state-store');
const {
  normalizeAccountEgressAssignment,
  normalizeNodeEntity,
  normalizePoolGroup,
  normalizeProxyPool
} = require('./egress-domain-contract');

const NODE_KEY_PREFIX = 'egress:entity:node:';
const POOL_KEY_PREFIX = 'egress:entity:pool:';
const POOL_GROUP_KEY_PREFIX = 'egress:entity:pool-group:';
const ASSIGNMENT_KEY_PREFIX = 'egress:entity:assignment:';

function normalizedId(value) {
  return String(value || '').trim();
}

function loadMap(fs, aiHomeDir, prefix, normalize) {
  const result = new Map();
  if (!fs || !aiHomeDir) return result;
  const stored = readJsonValuesByPrefix(fs, aiHomeDir, prefix);
  for (const [key, value] of stored) {
    const id = String(key).slice(prefix.length);
    try {
      const entity = normalize(value);
      if (entity && id === identityOf(entity)) result.set(id, entity);
    } catch (_error) {
      // A damaged or pre-contract record is ignored by the new projection.
      // It remains in app_kv for the compatibility/migration path to inspect.
    }
  }
  return result;
}

function identityOf(entity) {
  return entity.accountRef || entity.nodeId || entity.poolId || entity.poolGroupId || '';
}

function createEgressEntityStore(options = {}) {
  const fs = options.fs || null;
  const aiHomeDir = String(options.aiHomeDir || '').trim();
  const now = typeof options.now === 'function' ? options.now : () => Date.now();

  const nodes = loadMap(fs, aiHomeDir, NODE_KEY_PREFIX, normalizeNodeEntity);
  const pools = loadMap(fs, aiHomeDir, POOL_KEY_PREFIX, normalizeProxyPool);
  const poolGroups = loadMap(fs, aiHomeDir, POOL_GROUP_KEY_PREFIX, normalizePoolGroup);
  const assignments = loadMap(fs, aiHomeDir, ASSIGNMENT_KEY_PREFIX, normalizeAccountEgressAssignment);

  function persist(prefix, entity) {
    if (!fs || !aiHomeDir) return true;
    const id = identityOf(entity);
    if (!id || !writeJsonValue(fs, aiHomeDir, `${prefix}${id}`, entity)) {
      throw new Error('egress_entity_write_failed');
    }
    return true;
  }

  function putNode(raw) {
    const entity = normalizeNodeEntity(raw);
    nodes.set(entity.nodeId, entity);
    persist(NODE_KEY_PREFIX, entity);
    return entity;
  }

  function putPool(raw) {
    const entity = normalizeProxyPool(raw);
    pools.set(entity.poolId, entity);
    persist(POOL_KEY_PREFIX, entity);
    return entity;
  }

  function putPoolGroup(raw) {
    const entity = normalizePoolGroup(raw);
    poolGroups.set(entity.poolGroupId, entity);
    persist(POOL_GROUP_KEY_PREFIX, entity);
    return entity;
  }

  function putAssignment(raw) {
    const entity = normalizeAccountEgressAssignment(raw);
    const timestamp = Number(now());
    const withTimestamp = {
      ...entity,
      updatedAt: Number.isFinite(timestamp) ? timestamp : entity.updatedAt
    };
    assignments.set(withTimestamp.accountRef, withTimestamp);
    persist(ASSIGNMENT_KEY_PREFIX, withTimestamp);
    return withTimestamp;
  }

  function deleteAssignment(accountRef) {
    const ref = normalizedId(accountRef);
    if (!ref) return false;
    assignments.delete(ref);
    if (!fs || !aiHomeDir) return true;
    return deleteJsonValue(fs, aiHomeDir, `${ASSIGNMENT_KEY_PREFIX}${ref}`);
  }

  return {
    getNode: (nodeId) => nodes.get(normalizedId(nodeId)) || null,
    putNode,
    getPool: (poolId) => pools.get(normalizedId(poolId)) || null,
    putPool,
    getPoolGroup: (poolGroupId) => poolGroups.get(normalizedId(poolGroupId)) || null,
    putPoolGroup,
    listPoolGroups: () => [...poolGroups.values()],
    getAssignment: (accountRef) => assignments.get(normalizedId(accountRef)) || null,
    putAssignment,
    deleteAssignment,
    listAssignments: () => [...assignments.values()],
    listNodes: () => [...nodes.values()],
    listPools: () => [...pools.values()]
  };
}

module.exports = {
  ASSIGNMENT_KEY_PREFIX,
  NODE_KEY_PREFIX,
  POOL_GROUP_KEY_PREFIX,
  POOL_KEY_PREFIX,
  createEgressEntityStore
};
