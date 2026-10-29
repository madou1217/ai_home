'use strict';

// Resource-oriented projection.  NodeEntity rows only contain shared resource
// facts; account/provider evidence is intentionally absent from this view.

function text(value) {
  return String(value || '').trim();
}

function unique(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(text).filter(Boolean))];
}

function asRecord(source, id) {
  if (source instanceof Map) return source.get(id) || null;
  if (source && typeof source === 'object') return source[id] || null;
  return null;
}

function isAccountScoped(value) {
  if (!value || typeof value !== 'object') return true;
  const scope = text(value.scope).toLowerCase();
  return Boolean(value.accountRef || Array.isArray(value.accountRefs)
    || scope === 'account'
    || scope.startsWith('account_')
    || scope.includes('account_upstream'));
}

function safeState(value, kind) {
  if (!value || typeof value !== 'object' || isAccountScoped(value)) return null;
  const scope = text(value.scope).toLowerCase();
  // The health/policy channels are the explicit unscoped inputs.  A record
  // carrying any other evidence scope must stay out of the shared resource
  // tree, even if it happens to be passed through the nodeHealth/nodePolicy
  // argument by a compatibility caller.
  if (scope && scope !== `node_${kind}`) return null;
  const blocked = new Set([
    'accountRef', 'accountRefs', 'accountStatus', 'verdict', 'evidence',
    'provider', 'upstreamId', 'sessionId', 'sessionIds'
  ]);
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (blocked.has(key)) continue;
    result[key] = item;
  }
  return result;
}

function safeNode(node) {
  if (!node || typeof node !== 'object') return null;
  const allowed = [
    'nodeId', 'name', 'protocol', 'server', 'port', 'exitIdentity',
    'location', 'source', 'lifecycle', 'tags'
  ];
  const result = {};
  for (const key of allowed) {
    if (node[key] !== undefined) result[key] = node[key];
  }
  return result;
}

function membershipFor(memberships, poolId, nodeId) {
  const rows = Array.isArray(memberships) ? memberships : [];
  return rows.find((row) => row && row.poolId === poolId && row.nodeId === nodeId) || null;
}

function referenceCounts(memberships, poolId, nodeId, fallback) {
  const rows = (Array.isArray(memberships) ? memberships : [])
    .filter((row) => row && row.nodeId === nodeId);
  const poolIds = new Set(rows.map((row) => text(row.poolId)).filter(Boolean));
  if (fallback) poolIds.add(poolId);
  const accounts = new Set(rows.flatMap((row) => unique(row.accountRefs)));
  const sessions = new Set(rows.flatMap((row) => unique(row.sessionIds)));
  return { pools: poolIds.size, accounts: accounts.size, sessions: sessions.size };
}

function poolNodeIds(pool, memberships) {
  const explicit = Array.isArray(memberships)
    ? memberships.filter((row) => row && row.poolId === pool.poolId).map((row) => row.nodeId)
    : [];
  return unique([...(Array.isArray(pool.nodeIds) ? pool.nodeIds : []), ...explicit]);
}

function buildPoolView(pool, nodesById, memberships, nodeHealth, nodePolicy) {
  const nodeRows = poolNodeIds(pool, memberships).flatMap((nodeId) => {
    const node = nodesById.get(nodeId);
    if (!node) return [];
    const membership = membershipFor(memberships, pool.poolId, nodeId);
    return [{
      ...safeNode(node),
      membership: membership
        ? {
          poolId: pool.poolId,
          nodeId,
          enabled: membership.enabled !== false,
          ...(membership.priority !== undefined ? { priority: membership.priority } : {}),
          ...(membership.weight !== undefined ? { weight: membership.weight } : {})
        }
        : null,
      nodeHealth: safeState(asRecord(nodeHealth, nodeId), 'health'),
      nodePolicy: safeState(asRecord(nodePolicy, nodeId), 'policy'),
      referenceCounts: referenceCounts(memberships, pool.poolId, nodeId, !membership)
    }];
  });
  return {
    poolId: pool.poolId,
    poolGroupId: text(pool.poolGroupId),
    name: pool.name || pool.poolId,
    ...(pool.selectionModeDefault ? { selectionModeDefault: pool.selectionModeDefault } : {}),
    ...(pool.rotationPolicy ? { rotationPolicy: pool.rotationPolicy } : {}),
    ...(pool.healthPolicy ? { healthPolicy: pool.healthPolicy } : {}),
    ...(pool.upstreamCompatibilityPolicy ? { upstreamCompatibilityPolicy: pool.upstreamCompatibilityPolicy } : {}),
    enabled: pool.enabled !== false,
    nodes: nodeRows
  };
}

function buildEgressResourceView(input = {}) {
  const nodesById = new Map((Array.isArray(input.nodes) ? input.nodes : [])
    .filter((node) => node && node.nodeId)
    .map((node) => [node.nodeId, node]));
  const pools = Array.isArray(input.pools) ? input.pools : [];
  const groups = Array.isArray(input.poolGroups) ? input.poolGroups : [];
  const memberships = Array.isArray(input.memberships) ? input.memberships : [];
  const poolsById = new Map(pools.filter((pool) => pool && pool.poolId).map((pool) => [pool.poolId, pool]));
  const groupedPoolIds = new Set();

  const poolGroupViews = groups.map((group) => {
    const declared = unique(group.poolIds);
    const groupPools = [
      ...declared.map((poolId) => poolsById.get(poolId)).filter(Boolean),
      ...pools.filter((pool) => pool.poolGroupId === group.poolGroupId && !declared.includes(pool.poolId))
    ];
    groupPools.forEach((pool) => groupedPoolIds.add(pool.poolId));
    return {
      poolGroupId: group.poolGroupId,
      name: group.name || group.poolGroupId,
      ...(group.description ? { description: group.description } : {}),
      enabled: group.enabled !== false,
      pools: groupPools.map((pool) => buildPoolView(pool, nodesById, memberships, input.nodeHealth, input.nodePolicy))
    };
  });

  const ungroupedPools = pools
    .filter((pool) => !groupedPoolIds.has(pool.poolId))
    .map((pool) => buildPoolView(pool, nodesById, memberships, input.nodeHealth, input.nodePolicy));
  const referencedNodeIds = new Set(ungroupedPools.concat(poolGroupViews.flatMap((group) => group.pools))
    .flatMap((pool) => pool.nodes.map((node) => node.nodeId)));
  const unassignedNodes = [...nodesById.values()]
    .filter((node) => !referencedNodeIds.has(node.nodeId))
    .map(safeNode);

  return { poolGroups: poolGroupViews, ungroupedPools, unassignedNodes };
}

module.exports = { buildEgressResourceView };
