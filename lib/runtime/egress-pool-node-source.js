'use strict';

// 出口池的节点来源：从用户已有的代理池（proxy-pool.json）取节点。
//
// 为什么复用代理池而不是另建一套订阅：用户已经用订阅聚合器维护着一份节点库，
// 出口池只是**消费**它 —— 用户换订阅、加节点，出口池下次启动自然跟上，
// 不需要用户为出口池再做一次配置。这是「应用适配用户」而非「用户适配应用」。
//
// 读失败一律返回 { ok:false, error }，由调用方安静降级（出口池是增强能力）。

const { getProxyNodeStore } = require('../cli/services/toolkit/proxy-pool/proxy-node-store');

// 出口池只接受能编译成 mihomo 出站的节点。协议白名单不做硬编码 ——
// 交给 compileMihomoProxy 判定（它才是协议能力的单一事实来源），
// 这里只做形状预筛，避免把明显不可用的条目带进池子。
function isUsableNode(node) {
  if (!node || typeof node !== 'object') return false;
  if (!String(node.server || '').trim()) return false;
  const port = Number(node.port);
  return Number.isInteger(port) && port > 0 && port <= 65535;
}

/**
 * 读取代理池节点。
 *
 * @returns {{ ok: true, nodes: Array }|{ ok: false, error: string }}
 */
function readProxyPoolNodes(options = {}) {
  const aiHomeDir = String(options.aiHomeDir || '').trim();
  if (!aiHomeDir) return { ok: false, error: 'egress_pool_ai_home_missing' };

  let store;
  try {
    store = typeof options.getProxyNodeStore === 'function'
      ? options.getProxyNodeStore(options)
      : getProxyNodeStore({ fs: options.fs, aiHomeDir, env: options.env });
  } catch (error) {
    return {
      ok: false,
      error: `egress_pool_store_unavailable:${String((error && error.message) || error || '')}`
    };
  }

  let nodes;
  try {
    // 停用的订阅源不进出口池：节点留在库里，随时可在订阅源里重新启用。
    const disabled = new Set(
      (store.listSubscriptions ? store.listSubscriptions() : [])
        .filter((item) => item && item.enabled === false)
        .map((item) => item.id)
    );
    nodes = store.listNodes().filter((node) => !disabled.has(node.subscriptionId));
  } catch (error) {
    return {
      ok: false,
      error: `egress_pool_nodes_read_failed:${String((error && error.message) || error || '')}`
    };
  }

  const usable = dedupeByExit((Array.isArray(nodes) ? nodes : []).filter(isUsableNode));
  if (usable.length === 0) return { ok: false, error: 'egress_pool_no_nodes' };
  return { ok: true, nodes: usable };
}

/**
 * 同一出口只留一个节点。订阅常把「剩余流量 / 距离重置 / 套餐到期」这类信息行做成
 * 指向同一服务器的节点（实测 4 条全是 direct-us-01:36699）。池里留着它们，轮换就会
 * 在同一个被限的 IP 上连跳好几次、把跳数白白耗光（2026-10-18：node-0~3 全 403，
 * node-4 起全 200，网关却跳满 6 次落到 CLI 兜底）。出口 = 协议 + 服务器 + 端口 + 凭据。
 */
function exitKey(node) {
  const credential = node.uuid || node.password || node.username || '';
  return [node.protocol, String(node.server || '').trim().toLowerCase(), Number(node.port), credential].join('|');
}

function dedupeByExit(nodes) {
  const seen = new Set();
  return nodes.filter((node) => {
    const key = exitKey(node);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * 出口池的节点目录：可用节点 + 订阅聚合的自建分组（展开成出口身份集合）。
 * 分组读失败不影响节点（分组是可选的选择手段）。
 *
 * @returns {{ ok: true, nodes: Array, groups: Array<{ id, name, profileName, identities: string[] }> } | { ok:false, error }}
 */
function readEgressPoolCatalog(options = {}) {
  const source = readProxyPoolNodes(options);
  if (!source.ok) return source;
  let groups = [];
  try {
    const { exitIdentity } = require('./egress-pool-node-health');
    const { listAggregatorGroups } = require('../cli/services/toolkit/subscription-aggregator/group-nodes');
    const { getSubscriptionAggregatorStore } = require('../cli/services/toolkit/subscription-aggregator/profile-store');
    const storeOptions = { fs: options.fs, aiHomeDir: options.aiHomeDir, env: options.env };
    const nodeStore = typeof options.getProxyNodeStore === 'function'
      ? options.getProxyNodeStore(options)
      : getProxyNodeStore(storeOptions);
    const profiles = typeof options.listAggregatorProfiles === 'function'
      ? options.listAggregatorProfiles()
      : getSubscriptionAggregatorStore(storeOptions).listProfiles();
    const sources = (nodeStore.listSubscriptions ? nodeStore.listSubscriptions() : []).map((item) => ({ id: item.id, name: item.name }));
    groups = listAggregatorGroups(profiles, sources, nodeStore.listNodes()).map((group) => ({
      id: group.id,
      name: group.name,
      profileName: group.profileName,
      identities: [...new Set(group.nodes.map(exitIdentity).filter(Boolean))]
    }));
  } catch (_error) {
    groups = [];
  }
  return { ok: true, nodes: source.nodes, groups };
}

module.exports = {
  isUsableNode,
  readEgressPoolCatalog,
  readProxyPoolNodes
};
