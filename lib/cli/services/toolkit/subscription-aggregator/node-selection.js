'use strict';

const { buildProxyNodeConnectionKey } = require('../proxy-pool/proxy-node-store');
const { REGIONS, REGION_BY_CODE } = require('./catalog');

const MANUAL_SOURCE = Object.freeze({ id: 'manual', name: '手动节点' });

function flagCountryCode(text) {
  const chars = [...String(text || '')];
  for (let index = 0; index < chars.length - 1; index += 1) {
    const first = chars[index].codePointAt(0);
    const second = chars[index + 1].codePointAt(0);
    if (first >= 0x1f1e6 && first <= 0x1f1ff && second >= 0x1f1e6 && second <= 0x1f1ff) {
      return String.fromCharCode(first - 0x1f1e6 + 65, second - 0x1f1e6 + 65);
    }
  }
  return '';
}

/** 节点所属地区：国旗 emoji 优先，其次名称关键字；识别不出返回 null。 */
function detectRegion(...names) {
  for (const name of names) {
    const region = REGION_BY_CODE.get(flagCountryCode(name));
    if (region) return region;
  }
  for (const name of names) {
    const region = REGIONS.find((candidate) => candidate.pattern.test(String(name || '')));
    if (region) return region;
  }
  return null;
}

function compilePattern(pattern) {
  return pattern ? new RegExp(pattern, 'i') : null;
}

/**
 * 应用改名规则。正则**预编译一次**（`compileRenames`）后传入 ——
 * 之前每个节点都 new RegExp 一遍，2w 节点 × N 条规则就是几万次编译（热路径大头）。
 */
function applyRenames(name, compiled) {
  if (!compiled || !compiled.length) return name;
  return compiled.reduce((current, rename) => current.replace(rename.regex, rename.replace), name);
}

/** 把配置里的改名规则编译成可复用的正则表（同一份配置只编译一次）。 */
function compileRenames(renames) {
  return (Array.isArray(renames) ? renames : []).map((rename) => {
    let regex = null;
    try {
      regex = new RegExp(rename.pattern, 'gi');
    } catch (_error) {
      regex = null;
    }
    return regex ? { regex, replace: rename.replace } : null;
  }).filter(Boolean);
}

function resolveSourceScope(profile, sources) {
  const knownIds = new Set(sources.map((source) => source.id));
  const selected = profile.sources.all
    ? knownIds
    : new Set(profile.sources.subscriptionIds.filter((id) => knownIds.has(id)));
  return { knownIds, selected };
}

/**
 * 连接键的进程内缓存：按**节点对象身份**（WeakMap）记忆，所以节点被重新构造（例如重新读库）
 * 会自然重算，不会读到陈旧键；WeakMap 不持有强引用，不会拖住节点对象。
 * 收益：2w 节点的选择里，只有真正参与判定的节点才算哈希，且同一批里不重复算。
 */
function connectionKeyCache() {
  const cache = new WeakMap();
  return {
    keyOf(node) {
      if (!node || typeof node !== 'object') return buildProxyNodeConnectionKey(node);
      const cached = cache.get(node);
      if (cached) return cached;
      const key = buildProxyNodeConnectionKey(node);
      cache.set(node, key);
      return key;
    }
  };
}

/**
 * 从节点库挑出聚合配置要的节点：订阅源范围 → 协议 → 包含/排除正则 → 去重 → 改名并保证名称唯一。
 * 返回的条目带输出名、来源和地区，后续规划与渲染只认这些条目。
 */
function selectAggregatedNodes(profile, sources = [], nodes = [], options = {}) {
  // countOnly：只数选中的节点数（概览用）。跳过改名与条目构造 —— 这两步在 2w 节点时
  // 是纯浪费（概览只取 entries.length）。去重仍要算，因为它影响数量。
  const countOnly = options.countOnly === true;
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const { knownIds, selected } = resolveSourceScope(profile, sources);
  const include = compilePattern(profile.filter.include);
  const exclude = compilePattern(profile.filter.exclude);
  const protocols = new Set(profile.filter.protocols);
  // 改名规则编译一次（不是每个节点一次）。
  const compiledRenames = compileRenames(profile.naming.renames);
  // 连接键缓存：同一节点对象在同一批数据里只哈希一次；节点未变时跨调用也复用。
  const connectionKeys = connectionKeyCache();
  const seenConnections = new Set();
  const usedNames = new Set();
  const stats = { scoped: 0, filtered: 0, duplicates: 0, selected: 0 };
  const entries = [];

  for (const node of nodes) {
    const subscriptionId = node?.subscriptionId || null;
    const inSubscription = subscriptionId && knownIds.has(subscriptionId);
    if (inSubscription ? !selected.has(subscriptionId) : !profile.sources.includeManualNodes) continue;
    stats.scoped += 1;

    const originalName = String(node.name || '').trim();
    if ((protocols.size && !protocols.has(String(node.protocol || '').toLowerCase()))
      || (include && !include.test(originalName))
      || (exclude && exclude.test(originalName))) {
      stats.filtered += 1;
      continue;
    }

    if (profile.dedupe) {
      const key = connectionKeys.keyOf(node);
      if (seenConnections.has(key)) {
        stats.duplicates += 1;
        continue;
      }
      seenConnections.add(key);
    }

    if (countOnly) {
      stats.selected += 1;
      continue;
    }

    const source = inSubscription ? sourceById.get(subscriptionId) : MANUAL_SOURCE;
    let baseName = applyRenames(originalName, compiledRenames).trim()
      || `${node.protocol || 'proxy'}-${node.server || 'node'}`;
    if (profile.naming.sourcePrefix) baseName = `[${source.name}] ${baseName}`;
    let name = baseName;
    if (usedNames.has(name) && !profile.naming.sourcePrefix) name = `${baseName} · ${source.name}`;
    for (let counter = 2; usedNames.has(name); counter += 1) name = `${baseName} ${counter}`;
    usedNames.add(name);

    entries.push({
      node,
      name,
      sourceId: source.id,
      sourceName: source.name,
      region: detectRegion(originalName, name)
    });
  }
  // countOnly 时 entries 是空的，selected 已在循环里累加（不能在这里覆盖成 0）。
  if (!countOnly) stats.selected = entries.length;
  return { entries, stats };
}

module.exports = {
  MANUAL_SOURCE,
  detectRegion,
  flagCountryCode,
  selectAggregatedNodes
};
