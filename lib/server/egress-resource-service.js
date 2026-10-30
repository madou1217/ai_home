'use strict';

// Resource first read model for the egress WebUI.  This module is deliberately
// read only: PoolGroup/Pool/NodeEntity rows contain facts about shared
// resources, while account/provider/upstream evidence is assembled by the
// separate diagnostic projection below.

const { buildEgressResourceView } = require('./egress-resource-view');
const { createEgressEntityStore } = require('./egress-entity-store');
const { createEgressEvidenceStore, listEvidence } = require('./egress-evidence-store');
const { buildNodeEntityId } = require('../runtime/egress-node-identity');

function text(value) {
  return typeof value === 'string' ? value.trim() : String(value || '').trim();
}

function clone(value) {
  if (value === undefined || value === null) return value;
  if (Array.isArray(value)) return value.map(clone);
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
  return value;
}

function array(value) {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === 'object') : [];
}

function mapValues(source) {
  if (source instanceof Map) return source;
  if (!source || typeof source !== 'object') return new Map();
  return new Map(Object.entries(source));
}

function sharedStateMap(value, kind) {
  const source = mapValues(value);
  const result = new Map();
  source.forEach((entry, id) => {
    if (!entry || typeof entry !== 'object' || entry.accountRef || Array.isArray(entry.accountRefs)) return;
    const scope = text(entry.scope).toLowerCase();
    if (scope && scope !== `node_${kind}`) return;
    if (kind === 'health' && ['denied', 'blocked', 'red', 'account_blocked'].includes(text(entry.status).toLowerCase())) return;
    if (text(entry.reason).toLowerCase().includes('account')) return;
    result.set(id, entry);
  });
  return result;
}

function nodeIdOf(node) {
  return text(node && (node.nodeId || node.id || node.identity || node.name));
}

function snapshotNodes(input, describe) {
  const supplied = typeof input.listNodes === 'function' ? input.listNodes() : input.nodes;
  if (array(supplied).length) return array(supplied);
  const rows = describe && Array.isArray(describe.nodes) ? describe.nodes : [];
  return rows.map((node) => ({
    nodeId: text(node.nodeId) || buildNodeEntityId(node),
    name: text(node.name || node.label || node.nodeId || node.identity),
    runtimeName: text(node.runtimeName || node.runtimeNode || node.name),
    protocol: text(node.protocol),
    server: text(node.server),
    port: Number(node.port) || 0,
    exitIdentity: text(node.exitIdentity || node.identity),
    location: node.location || (node.countryCode ? { countryCode: node.countryCode, countryFlag: node.countryFlag } : null),
    source: text(node.source),
    lifecycle: 'active'
  })).filter((node) => node.nodeId);
}

function snapshotPools(input, nodes) {
  const supplied = typeof input.listPools === 'function' ? input.listPools() : input.pools;
  if (array(supplied).length) return array(supplied);
  if (!nodes.length) return [];
  return [{ poolId: 'default', poolGroupId: 'default', name: '出口池', nodeIds: nodes.map(nodeIdOf) }];
}

function snapshotGroups(input, pools) {
  const supplied = typeof input.listPoolGroups === 'function' ? input.listPoolGroups() : input.poolGroups;
  if (array(supplied).length) return array(supplied);
  const grouped = pools.filter((pool) => text(pool.poolGroupId));
  if (!grouped.length) return [];
  const ids = [...new Set(grouped.map((pool) => text(pool.poolGroupId)))];
  return ids.map((id) => ({ poolGroupId: id, name: id, poolIds: grouped.filter((pool) => text(pool.poolGroupId) === id).map((pool) => pool.poolId) }));
}

function deriveMemberships(input, pools, describe) {
  if (Array.isArray(input.memberships)) return input.memberships;
  if (typeof input.listMemberships === 'function') return array(input.listMemberships());
  const assignments = typeof input.listAssignments === 'function' ? array(input.listAssignments()) : [];
  if (assignments.length) {
    return assignments.flatMap((assignment) => {
      const poolId = text(assignment.poolId);
      if (!poolId) return [];
      const pool = pools.find((item) => item.poolId === poolId);
      // Resource membership describes the pool itself. A pinned account
      // selection changes account runtime allocation, but must not hide the
      // other NodeEntity members from the resource tree.
      const nodeIds = Array.isArray(pool && pool.nodeIds) ? pool.nodeIds : [];
      return nodeIds.map((id) => ({
        poolId,
        nodeId: text(id),
        enabled: true,
        accountRefs: assignment.accountRef ? [assignment.accountRef] : [],
        sessionIds: Array.isArray(assignment.sessionIds) ? assignment.sessionIds : []
      }));
    });
  }
  // Runtime health can tell us how many accounts/sessions reference a node.
  // Keep only aggregate references here; never copy account-specific evidence
  // or account IDs into the shared resource projection.
  const rows = [];
  const healthRows = describe && Array.isArray(describe.nodes) ? describe.nodes : [];
  const byName = new Map(healthRows.map((node) => [nodeIdOf(node), node]));
  pools.forEach((pool) => {
    (Array.isArray(pool.nodeIds) ? pool.nodeIds : []).forEach((nodeId) => {
      const health = byName.get(text(nodeId));
      rows.push({
        poolId: pool.poolId,
        nodeId: text(nodeId),
        enabled: true,
        // Counts are consumed by egress-resource-view and are not emitted as
        // account lists, preserving the resource/evidence boundary.
        accountRefs: Array.isArray(health && health.accounts) ? health.accounts.map((entry) => text(entry.accountRef)).filter(Boolean) : [],
        sessionIds: []
      });
    });
  });
  return rows;
}

function stableNodeId(runtimeId, nodes) {
  const id = text(runtimeId);
  const found = nodes.find((node) => [node.nodeId, node.runtimeName, node.runtimeNode, node.name, node.exitIdentity].some((candidate) => text(candidate) === id));
  return found ? found.nodeId : id;
}

function remapState(value, nodes) {
  const result = new Map();
  mapValues(value).forEach((entry, id) => result.set(stableNodeId(id, nodes), entry));
  return result;
}

function describeNodeHealth(describe, nodes) {
  const rows = describe && Array.isArray(describe.nodes) ? describe.nodes : [];
  const result = new Map();
  rows.forEach((node) => {
    const id = stableNodeId(nodeIdOf(node), nodes);
    if (!id) return;
    const status = node.blocked ? 'blocked' : node.cooling ? 'cooling' : node.probe && node.probe.ok === false ? 'unreachable' : node.probe && node.probe.ok ? 'healthy' : 'unknown';
    result.set(id, { status, ...(node.probe ? { latencyMs: node.probe.latencyMs, at: node.probe.at } : {}) });
  });
  return result;
}

function describeNodePolicy(describe, nodes) {
  const rows = describe && Array.isArray(describe.nodes) ? describe.nodes : [];
  const result = new Map();
  rows.forEach((node) => {
    const id = stableNodeId(nodeIdOf(node), nodes);
    if (!id || !node.blocked) return;
    result.set(id, { disabled: true, reason: text(node.blockedReason || node.blockedDetail) });
  });
  return result;
}

function createEgressResourceService(options = {}) {
  const describe = typeof options.describeEgressPool === 'function' ? options.describeEgressPool() : (options.describeEgressPool || null);
  const entityStore = options.entityStore || null;
  const evidenceStore = options.evidenceStore || null;

  function source() {
    const entitySource = { ...options, ...(entityStore || {}) };
    const nodes = snapshotNodes(entitySource, describe);
    const pools = snapshotPools(entitySource, nodes);
    const poolGroups = snapshotGroups(entitySource, pools);
    const memberships = deriveMemberships(entitySource, pools, describe);
    const nodeHealth = sharedStateMap(options.nodeHealth
      ? remapState(options.nodeHealth, nodes)
      : describeNodeHealth(describe, nodes), 'health');
    const nodePolicy = sharedStateMap(options.nodePolicy
      ? remapState(options.nodePolicy, nodes)
      : describeNodePolicy(describe, nodes), 'policy');
    return { nodes, pools, poolGroups, memberships, nodeHealth, nodePolicy };
  }

  function buildResourceTreeView() {
    const raw = source();
    const view = buildEgressResourceView(raw);
    const runtimeNames = new Map(raw.nodes.map((node) => [nodeIdOf(node), text(node.runtimeName || node.runtimeNode)]));
    (describe && Array.isArray(describe.nodes) ? describe.nodes : []).forEach((runtimeNode) => {
      const stableId = stableNodeId(nodeIdOf(runtimeNode), raw.nodes);
      const runtimeName = text(runtimeNode.name || runtimeNode.runtimeName || runtimeNode.runtimeNode);
      if (stableId && runtimeName) runtimeNames.set(stableId, runtimeName);
    });
    const addRuntimeNames = (groups) => groups.map((group) => ({
      ...group,
      pools: (group.pools || []).map((pool) => ({
        ...pool,
        nodes: (pool.nodes || []).map((node) => ({
          ...node,
          ...(runtimeNames.get(node.nodeId) ? { runtimeName: runtimeNames.get(node.nodeId) } : {})
        }))
      }))
    }));
    const groups = addRuntimeNames(view.poolGroups.map(clone));
    if (view.ungroupedPools.length) {
      groups.push(...addRuntimeNames([{ poolGroupId: 'ungrouped', name: '未分组池', enabled: true, pools: clone(view.ungroupedPools) }]));
    }
    if (view.unassignedNodes.length) {
      groups.push(...addRuntimeNames([{
        poolGroupId: 'unassigned',
        name: '未分配节点',
        enabled: true,
        pools: [{ poolId: 'unassigned', poolGroupId: 'unassigned', name: '未分配节点', enabled: true, nodes: clone(view.unassignedNodes) }]
      }]));
    }
    return groups;
  }

  function findPool(poolId) {
    const id = text(poolId);
    return buildResourceTreeView().flatMap((group) => group.pools || []).find((pool) => pool.poolId === id) || null;
  }

  function findNode(nodeId) {
    const id = text(nodeId);
    return buildResourceTreeView().flatMap((group) => group.pools || [])
      .flatMap((pool) => pool.nodes || []).find((node) => node.nodeId === id) || null;
  }

  function buildAccountDiagnosticView(query = {}) {
    const normalized = {
      provider: text(query.provider).toLowerCase(),
      accountRef: text(query.accountRef),
      upstreamId: text(query.upstreamId || query.upstream).toLowerCase(),
      nodeId: text(query.nodeId || query.node)
    };
    const store = evidenceStore || options.egressEvidenceStore;
    let evidence = [];
    if (store && typeof store.listEvidence === 'function') {
      try { evidence = store.listEvidence({ ...normalized, includeLegacy: false }); } catch (_error) { evidence = []; }
    } else if (Array.isArray(options.evidence)) {
      evidence = options.evidence.filter((entry) => Object.entries(normalized).every(([key, value]) => !value || text(entry[key]).toLowerCase() === value.toLowerCase()));
    }
    // Diagnostic rows remain scoped records.  The UI may explain a provider or
    // account denial, but this projection never emits a node-wide blocked flag.
    const scoped = evidence.filter((entry) => entry && entry.scope && entry.scope !== 'legacy_unscoped_evidence');
    const denied = scoped.filter((entry) => entry.status === 'blocked').length;
    return {
      scope: 'account_diagnostic',
      query: normalized,
      evidence: clone(scoped),
      summary: { total: scoped.length, denied, allowed: scoped.filter((entry) => entry.status === 'ok' || entry.status === 'reachable').length },
      globalBlocking: false
    };
  }

  return {
    buildResourceTreeView,
    buildAccountDiagnosticView,
    listPoolGroups: () => buildResourceTreeView(),
    listPools: () => buildResourceTreeView().flatMap((group) => group.pools || []),
    getPool: findPool,
    getNode: findNode,
    source
  };
}

function createDefaultEgressResourceService(ctx = {}) {
  const deps = ctx.deps || {};
  const state = ctx.state || {};
  const fs = ctx.fs || deps.fs;
  const aiHomeDir = text(ctx.aiHomeDir || deps.aiHomeDir || state.aiHomeDir);
  const entityStore = deps.egressEntityStore || state.egressEntityStore || (fs && aiHomeDir ? createEgressEntityStore({ fs, aiHomeDir }) : null);
  const evidenceStore = deps.egressEvidenceStore || state.egressEvidenceStore || (fs && aiHomeDir ? createEgressEvidenceStore({ fs, aiHomeDir }) : null);
  let describe = null;
  try {
    // eslint-disable-next-line global-require
    describe = require('../runtime/egress-pool-registry').describeEgressPool();
  } catch (_error) { describe = null; }
  return createEgressResourceService({
    entityStore,
    evidenceStore,
    describeEgressPool: deps.describeEgressPool || state.describeEgressPool || describe,
    nodes: deps.egressNodes || state.egressNodes,
    pools: deps.egressPools || state.egressPools,
    poolGroups: deps.egressPoolGroups || state.egressPoolGroups,
    memberships: deps.egressMemberships || state.egressMemberships,
    evidence: deps.egressEvidence || state.egressEvidence
  });
}

function buildResourceTreeView(input = {}) {
  return createEgressResourceService(input).buildResourceTreeView();
}

function buildAccountDiagnosticView(input = {}, query = {}) {
  let source = input;
  let filters = query;
  if (arguments.length < 2 && input && typeof input === 'object'
    && ['provider', 'accountRef', 'upstreamId', 'upstream', 'nodeId', 'node'].some((key) => input[key])) {
    source = { evidenceStore: { listEvidence } };
    filters = input;
  } else if (!(input && (input.evidenceStore || input.egressEvidenceStore || input.evidence))) {
    source = { evidence: Array.isArray(input) ? input : [] };
  }
  return createEgressResourceService(source).buildAccountDiagnosticView(filters);
}

module.exports = {
  buildAccountDiagnosticView,
  buildResourceTreeView,
  createDefaultEgressResourceService,
  createEgressResourceService
};
