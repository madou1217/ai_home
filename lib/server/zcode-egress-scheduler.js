'use strict';

// ZCode 节点选择只处理纯领域决策：健康性、策略、sticky 与租约避重。
// 它不读文件、不启动代理核心，也不修改系统网络，因此可以被 Desktop、CLI 和
// 后续运行时故障回报共用。

const STRATEGY_LOWEST_LATENCY = 'lowest_latency';
const STRATEGY_ROUND_ROBIN = 'round_robin';
const STRATEGY_RANDOM = 'random';
const STRATEGY_STICKY = 'sticky';
const SUPPORTED_STRATEGIES = new Set([
  STRATEGY_STICKY,
  STRATEGY_LOWEST_LATENCY,
  STRATEGY_ROUND_ROBIN,
  STRATEGY_RANDOM
]);

function normalizeStrategy(value, fallback = STRATEGY_LOWEST_LATENCY) {
  const strategy = String(value || '').trim().toLowerCase();
  return SUPPORTED_STRATEGIES.has(strategy) ? strategy : fallback;
}

function isHealthyNode(node, failedNodeIds) {
  if (!node || !node.id || node.disabled === true) return false;
  if (failedNodeIds.has(node.id)) return false;
  const latencyMs = Number(node.latencyMs);
  return node.latencyMs === null
    || node.latencyMs === undefined
    || (Number.isFinite(latencyMs) && latencyMs >= 0);
}

function lowestLatencyNode(nodes) {
  return [...nodes].sort((left, right) => {
    const leftLatency = left.latencyMs === null || left.latencyMs === undefined
      ? Number.NaN
      : Number(left.latencyMs);
    const rightLatency = right.latencyMs === null || right.latencyMs === undefined
      ? Number.NaN
      : Number(right.latencyMs);
    const leftRank = Number.isFinite(leftLatency) && leftLatency >= 0
      ? leftLatency
      : Number.POSITIVE_INFINITY;
    const rightRank = Number.isFinite(rightLatency) && rightLatency >= 0
      ? rightLatency
      : Number.POSITIVE_INFINITY;
    if (leftRank !== rightRank) return leftRank - rightRank;
    return String(left.id).localeCompare(String(right.id));
  })[0] || null;
}

function roundRobinNode(nodes, lastSelectedNodeId, ringNodes = nodes) {
  if (!nodes.length) return null;
  const candidatesById = new Map(nodes.map((node) => [node.id, node]));
  const ring = Array.isArray(ringNodes) && ringNodes.length ? ringNodes : nodes;
  const currentIndex = ring.findIndex((node) => node.id === lastSelectedNodeId);
  if (currentIndex >= 0) {
    for (let offset = 1; offset <= ring.length; offset += 1) {
      const node = candidatesById.get(ring[(currentIndex + offset) % ring.length]?.id);
      if (node) return node;
    }
  }
  return nodes[0];
}

function randomNode(nodes, random) {
  if (!nodes.length) return null;
  const value = Number(random());
  const normalized = Number.isFinite(value) ? Math.min(Math.max(value, 0), 0.999999999999) : 0;
  return nodes[Math.floor(normalized * nodes.length)];
}

function chooseNode(nodes, strategy, input) {
  if (strategy === STRATEGY_STICKY) {
    return nodes.find((node) => node.id === input.lastSelectedNodeId)
      || lowestLatencyNode(nodes);
  }
  if (strategy === STRATEGY_ROUND_ROBIN) {
    return roundRobinNode(nodes, input.lastSelectedNodeId, input.ringNodes);
  }
  if (strategy === STRATEGY_RANDOM) {
    return randomNode(nodes, input.random);
  }
  return lowestLatencyNode(nodes);
}

/**
 * @param {object} input
 * @returns {{ok: true, nodeId: string, node: object, strategy: string, sticky: boolean,
 *   failover: boolean, reused: boolean}|{ok: false, error: string, groupId: string}}
 */
function selectZcodeEgressNode(input = {}) {
  const group = input.group && typeof input.group === 'object' ? input.group : {};
  const groupId = String(group.id || '').trim();
  const ownerId = String(input.ownerId || '').trim();
  const failedNodeIds = new Set((input.failedNodeIds || []).map(String));
  const selectableNodes = (Array.isArray(input.nodes) ? input.nodes : [])
    .filter((node) => isHealthyNode(node, failedNodeIds));
  const currentNodeId = String(input.currentNodeId || '').trim();
  const current = currentNodeId
    ? selectableNodes.find((node) => node.id === currentNodeId)
    : null;
  if (current) {
    return {
      ok: true,
      nodeId: current.id,
      node: current,
      strategy: normalizeStrategy(group.strategy),
      sticky: true,
      failover: false,
      reused: false
    };
  }
  const knownHealthyNodes = selectableNodes.filter((node) => (
    node.latencyMs !== null
    && node.latencyMs !== undefined
    && Number.isFinite(Number(node.latencyMs))
    && Number(node.latencyMs) >= 0
  ));
  const nodes = knownHealthyNodes.length > 0 ? knownHealthyNodes : selectableNodes;
  if (!nodes.length) return { ok: false, error: 'no_available_proxy_node', groupId };

  const occupiedNodeIds = new Set((input.leases || [])
    .filter((lease) => lease && lease.releasedAt == null && String(lease.ownerId || '') !== ownerId)
    .map((lease) => String(lease.nodeId || ''))
    .filter(Boolean));
  const unoccupied = nodes.filter((node) => !occupiedNodeIds.has(node.id));
  const reused = unoccupied.length === 0;
  const candidates = reused ? nodes : unoccupied;
  const failover = Boolean(currentNodeId && !current);
  const strategy = failover
    ? normalizeStrategy(group.failoverStrategy)
    : normalizeStrategy(group.strategy);
  const selected = chooseNode(candidates, strategy, {
    lastSelectedNodeId: String(input.lastSelectedNodeId || '').trim(),
    ringNodes: Array.isArray(input.nodes) ? input.nodes : selectableNodes,
    random: typeof input.random === 'function' ? input.random : Math.random
  });
  if (!selected) return { ok: false, error: 'no_available_proxy_node', groupId };
  return {
    ok: true,
    nodeId: selected.id,
    node: selected,
    strategy,
    sticky: false,
    failover,
    reused
  };
}

module.exports = {
  STRATEGY_LOWEST_LATENCY,
  STRATEGY_RANDOM,
  STRATEGY_ROUND_ROBIN,
  STRATEGY_STICKY,
  selectZcodeEgressNode
};
