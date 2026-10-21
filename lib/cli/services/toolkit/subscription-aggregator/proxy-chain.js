'use strict';

/**
 * 链式代理（内部前置代理）：一个节点可以指定「前置节点」，前置节点自己还能有前置，
 * 形成 A → B → C 的多级链。中立层只做两件事：
 *
 * 1. 把「前置节点 id」解析成该节点在**本次输出**里的名字（节点会被改名 / 去重 / 按格式清洗，
 *    所以只能在这里解析，不能把名字写进节点）；
 * 2. 检出成环、前置没被选中、链太长这些配置错误。
 *
 * 各输出目标能表达链式的写法不同（mihomo 的 dialer-proxy、sing-box 的 detour、Surge 的
 * underlying-proxy），渲染器用 capabilities.proxyChain 声明支不支持；解析不出来的节点
 * **整个跳过**而不是只丢前置 —— 丢掉前置会让流量从出口节点直连，等于漏真实 IP。
 */

const { nodeKeyOf } = require('../../../../runtime/node-identity');

// 一条链最多几跳，防止配置里出现超长（但无环）的链把编译顺序与输出撑爆。
const MAX_CHAIN_DEPTH = 8;

// 编译结果上的链式目标（名字 / tag）。Symbol 键对 JSON.stringify 与 Object.keys 不可见，
// 所以 sing-box 的出站对象照样能直接序列化。
const CHAIN_TARGET = Symbol('aih.chainTarget');

function chainRefOf(node) {
  const ref = node && node.chain;
  return typeof ref === 'string' && ref.trim() ? ref.trim() : '';
}

/** 把链式目标挂到编译结果上（返回新对象，不改原对象）。 */
function withChainTarget(item, target) {
  if (!target) return item;
  return { ...item, [CHAIN_TARGET]: target };
}

function chainTargetOf(item) {
  return item ? item[CHAIN_TARGET] : undefined;
}

/**
 * 链式前置的查找索引：**同时按节点 id 与连接身份（nodeKey）索引**。
 * 为什么要两套：node_ id 的种子含 name，改名就漂（见 lib/runtime/node-identity.js），
 * 所以新引用一律用 nodeKey；存量配置里存的还是 id，继续认，不做一次性迁移。
 */
function chainIndex(pairs) {
  const byRef = new Map();
  for (const [node, value] of pairs) {
    if (!node) continue;
    const id = node.id;
    if (id && !byRef.has(id)) byRef.set(id, value);
    const key = nodeKeyOf(node);
    if (key && !byRef.has(key)) byRef.set(key, value);
  }
  return byRef;
}

/** 沿链向上走，检出环与超长链；上游自己缺前置不算本节点的错（它自己会报）。 */
function walkChain(entry, byId) {
  const seen = new Set([entry.node.id]);
  let cursor = byId.get(chainRefOf(entry.node));
  let depth = 0;
  while (cursor) {
    depth += 1;
    if (depth > MAX_CHAIN_DEPTH) return 'invalid_proxy_chain_too_deep';
    const id = cursor.node?.id;
    if (!id || seen.has(id)) return 'invalid_proxy_chain_cycle';
    seen.add(id);
    const next = chainRefOf(cursor.node);
    cursor = next ? byId.get(next) : null;
  }
  return '';
}

/**
 * 解析每个条目的链式前置。
 * 返回 { targets: Map<entry, 上游 entry>, errors: Map<entry, 错误码> }；
 * 没配前置、或配的前置解析失败的条目不会出现在 targets 里。
 */
function resolveProxyChains(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const byId = chainIndex(list.map((entry) => [entry?.node, entry]));
  const targets = new Map();
  const errors = new Map();
  for (const entry of list) {
    const ref = chainRefOf(entry?.node);
    if (!ref) continue;
    if (ref === entry.node.id) {
      errors.set(entry, 'invalid_proxy_chain_cycle');
      continue;
    }
    const upstream = byId.get(ref);
    if (!upstream) {
      errors.set(entry, 'invalid_proxy_chain_missing');
      continue;
    }
    const failure = walkChain(entry, byId);
    if (failure) errors.set(entry, failure);
    else targets.set(entry, upstream);
  }
  return { targets, errors };
}

/**
 * 编译顺序：前置节点先编译（依赖它的节点要判断前置有没有编出来）。
 * 没有前置的节点之间保持原有相对顺序，输出里的节点次序基本不变。
 */
function orderEntriesByChain(entries, targets) {
  const emitted = new Set();
  const ordered = [];
  const visit = (entry) => {
    if (emitted.has(entry)) return;
    const upstream = targets.get(entry);
    if (upstream) visit(upstream);
    emitted.add(entry);
    ordered.push(entry);
  };
  for (const entry of entries) visit(entry);
  return ordered;
}

/** 一条链从本节点起向上收集所有节点 id（含自己），用于界面展示整条链。 */
function chainIdsOf(nodeId, nodesById) {
  const ids = [];
  const seen = new Set();
  let cursor = nodeId;
  while (cursor && !seen.has(cursor) && ids.length <= MAX_CHAIN_DEPTH) {
    seen.add(cursor);
    ids.push(cursor);
    cursor = chainRefOf(nodesById.get(cursor));
  }
  return ids;
}

/**
 * 保存前置之前先算一遍：把 nodeId 的前置改成 chainRef 会不会立刻出问题。
 * 返回错误码，没问题返回空串。写法与 resolveProxyChains 一致，只是**预演**：
 * 界面上点保存就报错，不用等到预览时才发现整条链被跳过。
 *
 * 这里能检出「成环」是因为新前置自己的链上如果已经有 nodeId，说明这次改动把
 * nodeId 接回了自己的下游（A→B，现在又让 B→A）。
 */
function validateChainRef(nodes, nodeId, chainRef) {
  const ref = typeof chainRef === 'string' ? chainRef.trim() : '';
  if (!ref) return '';
  if (ref === nodeId) return 'invalid_proxy_chain_cycle';
  const byId = chainIndex((Array.isArray(nodes) ? nodes : []).map((node) => [node, node]));
  if (!byId.has(ref)) return 'invalid_proxy_chain_missing';
  const seen = new Set([nodeId]);
  let cursor = byId.get(ref);
  let depth = 0;
  while (cursor) {
    depth += 1;
    if (depth > MAX_CHAIN_DEPTH) return 'invalid_proxy_chain_too_deep';
    const id = cursor.id;
    if (!id || seen.has(id)) return 'invalid_proxy_chain_cycle';
    seen.add(id);
    const next = chainRefOf(cursor);
    cursor = next ? byId.get(next) : null;
  }
  return '';
}

module.exports = {
  CHAIN_TARGET,
  MAX_CHAIN_DEPTH,
  chainIdsOf,
  chainRefOf,
  chainTargetOf,
  orderEntriesByChain,
  resolveProxyChains,
  validateChainRef,
  withChainTarget
};
