'use strict';

const { MAX_CHAIN_DEPTH, chainRefOf } = require('../proxy-chain');

/**
 * 中转批次的**公共规划**（与内核无关）：谁要有本地入口、链上前置是谁、哪些因为链的问题直接跳过、
 * 以及「上游编不出来时下游一起剔除」。sing-box 与 mihomo 两个内核的配置编译都走这里，
 * 差别只在「节点怎么编成出站 / 配置长什么样」（见 relay-config.js、mihomo-config.js）。
 */

/** 沿前置向上走，检出成环 / 缺失 / 超长；返回 { ok, chain: [本节点, 前置, 前置的前置…] }。 */
function walkChain(node, byId) {
  const chain = [];
  const seen = new Set();
  let cursor = node;
  while (cursor) {
    if (seen.has(cursor.id)) return { ok: false, reason: 'invalid_proxy_chain_cycle' };
    seen.add(cursor.id);
    chain.push(cursor);
    if (chain.length > MAX_CHAIN_DEPTH + 1) return { ok: false, reason: 'invalid_proxy_chain_too_deep' };
    const ref = chainRefOf(cursor);
    if (!ref) break;
    const upstream = byId.get(ref);
    if (!upstream) return { ok: false, reason: 'invalid_proxy_chain_missing' };
    cursor = upstream;
  }
  return { ok: true, chain };
}

/**
 * 传进来的应当只有「目标格式表达不了、需要中转」的节点。
 *
 * options.onlyIds 给出「谁要有本地入口」的子集（其余节点只作为链上前置参与编译）。不传就是全部。
 * 这一层是必要的：A 要中转、A 的前置 B 是内核本来就认的协议时，B 不该白开一个端口，但 B 必须
 * 在配置里当出站，否则 A 的 detour 指向不存在的 tag。
 *
 * → { byId, wanted, upstreamIds, skipped }
 *   wanted：要有入口的节点（按传入顺序，已截到 maxPorts）
 *   upstreamIds：链上被引用、但自己不需要入口的节点 id
 */
function planRelayBatch(nodes, { onlyIds = null, maxPorts = 256 } = {}) {
  const list = Array.isArray(nodes) ? nodes.filter((node) => node && node.id) : [];
  const byId = new Map(list.map((node) => [node.id, node]));
  const skipped = [];

  // 1. 先定「谁要有入口」：链本身有问题的（成环 / 前置缺失 / 超长）一律不给，
  //    让渲染器按原有逻辑跳过它 —— 宁可少一个节点，也不要写出会让整份配置被拒的内容。
  const wanted = [];
  for (const node of list) {
    const walk = walkChain(node, byId);
    if (!walk.ok) {
      if (!onlyIds || onlyIds.has(node.id)) skipped.push({ nodeId: node.id, reason: walk.reason });
      continue;
    }
    if (onlyIds && !onlyIds.has(node.id)) continue;
    wanted.push(node);
  }
  const limited = wanted.slice(0, maxPorts);
  for (const node of wanted.slice(maxPorts)) skipped.push({ nodeId: node.id, reason: 'too_many_relay_nodes' });

  // 1b. 链上的前置都要能编出来（哪怕它自己不需要入口），否则 detour 指向不存在的 tag。
  //     只沿「要有入口的节点」向上收，避免为没人用的节点白编出站。
  const upstreamIds = new Set();
  const pending = limited.map((node) => node.id);
  while (pending.length) {
    const walk = walkChain(byId.get(pending.shift()), byId);
    if (!walk.ok) continue;
    for (const upstream of walk.chain.slice(1)) {
      if (upstreamIds.has(upstream.id)) continue;
      upstreamIds.add(upstream.id);
      pending.push(upstream.id);
    }
  }
  return { byId, wanted: limited, upstreamIds, skipped };
}

/**
 * 上游编不出来、或压根不在名单里的，依赖它的节点也一起剔除：丢掉前置会让流量从出口节点直连，
 * 等于漏真实 IP。剔除会沿链传递（A→B→C，C 被剔除则 B 也不留）。
 * 就地修改 compiled / endpoints / failed / skipped。
 */
function pruneChainFailures({ byId, compiled, endpoints, failed, skipped }) {
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of [...compiled.keys()]) {
      const upstream = chainRefOf(byId.get(id));
      if (upstream && !compiled.has(upstream)) {
        failed.set(id, 'unsupported_proxy_chain_upstream_skipped');
        compiled.delete(id);
        changed = true;
      }
    }
  }
  for (const id of failed.keys()) {
    // 只有本来要有入口的节点才值得报给调用方；纯链上前置编不出来时，受影响的是它的下游。
    const hadEndpoint = endpoints.delete(id);
    if (hadEndpoint && !skipped.some((item) => item.nodeId === id)) skipped.push({ nodeId: id, reason: failed.get(id) });
  }
  return { compiled, endpoints, skipped };
}

module.exports = {
  planRelayBatch,
  pruneChainFailures,
  walkChain
};
