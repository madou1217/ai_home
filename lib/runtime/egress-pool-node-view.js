'use strict';

// 出口池节点列表的**筛选 / 排序 / 分页**判定 —— 服务端分页的唯一真相。
//
// 为什么要有这个模块（2026-10-22）：2w 节点的视图有 11.8MB，前端每 5 秒拉一次等于持续占带宽，
// 首屏也要 2.8s。正解是服务端分页，但一旦分页，"哪些节点在这一页"就必须由服务端决定 ——
// 而前端原本自己 filter + sort。把判定收敛到一处、两端共用，才不会出现
// "前端筛出 100 条、服务端只给了 50 条、页数对不上" 这类不一致。
//
// 与前端 `web/src/features/egress-pool/egress-pool-presentation.ts` 的 filterNodes/sortNodes
// 是**同一套语义**（那边有单测），这里补一份等价实现供服务端分页使用；
// 契约由 test/egress-pool-node-view.test.js 与前端测试双向锁定。

// 与前端一致的筛选类别。
const NODE_FILTERS = Object.freeze(['all', 'healthy', 'cooling', 'blocked', 'used']);

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** 搜索用的匹配文本（名称 + 展示名 + 服务器）。 */
function searchTextOf(node) {
  return `${node.name || ''} ${node.label || ''} ${node.server || ''}`.toLowerCase();
}

/**
 * 一个节点是否属于某个筛选类别。
 * healthy = 没冷却、没被拦截、且探测没失败（与前端 filterNodes 同义）。
 */
function matchesFilter(node, filter) {
  const kind = NODE_FILTERS.includes(filter) ? filter : 'all';
  if (kind === 'blocked') return node.blocked === true;
  if (kind === 'cooling') return node.cooling === true;
  if (kind === 'healthy') return !node.blocked && !node.cooling && !(node.probe && node.probe.ok === false);
  if (kind === 'used') return Number(node.uses) > 0;
  return true;
}

/** 筛选：类别 + 关键词（关键词为空则只按类别）。 */
function filterNodes(nodes, filter, query) {
  const needle = normalizeString(query).toLowerCase();
  return (Array.isArray(nodes) ? nodes : []).filter((node) => {
    if (!matchesFilter(node, filter)) return false;
    if (!needle) return true;
    return searchTextOf(node).includes(needle);
  });
}

/**
 * 排序：当前出口置顶 → 冷却中（剩余时间短的先）→ 最近使用。
 * 与前端 sortNodes 同序，保证分页后「第一页第一条」两边一致。
 */
function sortNodes(nodes, activeNode) {
  const active = normalizeString(activeNode);
  return (Array.isArray(nodes) ? nodes : []).slice().sort((a, b) => {
    if (a.name === active) return -1;
    if (b.name === active) return 1;
    if (a.cooling !== b.cooling) return a.cooling ? -1 : 1;
    if (a.cooling && b.cooling) return (a.cooldownRemainingMs || 0) - (b.cooldownRemainingMs || 0);
    return (Number(b.lastUsedAt) || 0) - (Number(a.lastUsedAt) || 0);
  });
}

/** 各筛选类别下的条数（分页控件的计数徽标用，一次遍历算完）。 */
function countByFilter(nodes) {
  const list = Array.isArray(nodes) ? nodes : [];
  const counts = { all: list.length, healthy: 0, cooling: 0, blocked: 0, used: 0 };
  for (const node of list) {
    if (node.blocked) counts.blocked += 1;
    if (node.cooling) counts.cooling += 1;
    if (matchesFilter(node, 'healthy')) counts.healthy += 1;
    if (Number(node.uses) > 0) counts.used += 1;
  }
  return counts;
}

/**
 * 分页切片。返回 { nodes, total, page, pageSize, pageCount }。
 * page 从 1 开始；超出范围时夹到最后一页（删节点后前端还停在旧页是常见情况）。
 */
function paginateNodes(nodes, { page = 1, pageSize = 50 } = {}) {
  const list = Array.isArray(nodes) ? nodes : [];
  const size = Math.max(1, Math.min(500, Number(pageSize) || 50));
  const pageCount = Math.max(1, Math.ceil(list.length / size));
  const safePage = Math.max(1, Math.min(pageCount, Number(page) || 1));
  const start = (safePage - 1) * size;
  return {
    nodes: list.slice(start, start + size),
    total: list.length,
    page: safePage,
    pageSize: size,
    pageCount
  };
}

/** 版本指纹：节点状态变化就变，用于 ETag（前端据此跳过重复下载）。 */
function nodesVersion(nodes) {
  const crypto = require('node:crypto');
  const hash = crypto.createHash('sha1');
  for (const node of Array.isArray(nodes) ? nodes : []) {
    // 只喂会影响展示的字段：cooldownRemainingMs 每毫秒都变，必须排除（否则每次都算新版本）。
    hash.update(`${node.name}|${node.cooling ? 1 : 0}|${node.cooldownUntil || 0}|${node.blocked ? 1 : 0}|${node.uses || 0}|${node.lastUsedAt || 0}|${node.probe ? `${node.probe.ok ? 1 : 0}:${node.probe.latencyMs || 0}:${node.probe.at || 0}` : ''}\n`);
  }
  return hash.digest('hex').slice(0, 16);
}

module.exports = {
  NODE_FILTERS,
  countByFilter,
  filterNodes,
  matchesFilter,
  nodesVersion,
  paginateNodes,
  sortNodes
};
