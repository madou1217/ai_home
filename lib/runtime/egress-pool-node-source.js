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
    nodes = store.listNodes();
  } catch (error) {
    return {
      ok: false,
      error: `egress_pool_nodes_read_failed:${String((error && error.message) || error || '')}`
    };
  }

  const usable = (Array.isArray(nodes) ? nodes : []).filter(isUsableNode);
  if (usable.length === 0) return { ok: false, error: 'egress_pool_no_nodes' };
  return { ok: true, nodes: usable };
}

module.exports = {
  isUsableNode,
  readProxyPoolNodes
};
