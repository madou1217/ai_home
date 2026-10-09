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

function applyRenames(name, renames) {
  return renames.reduce((current, rename) => current.replace(new RegExp(rename.pattern, 'gi'), rename.replace), name);
}

function resolveSourceScope(profile, sources) {
  const knownIds = new Set(sources.map((source) => source.id));
  const selected = profile.sources.all
    ? knownIds
    : new Set(profile.sources.subscriptionIds.filter((id) => knownIds.has(id)));
  return { knownIds, selected };
}

/**
 * 从节点库挑出聚合配置要的节点：订阅源范围 → 协议 → 包含/排除正则 → 去重 → 改名并保证名称唯一。
 * 返回的条目带输出名、来源和地区，后续规划与渲染只认这些条目。
 */
function selectAggregatedNodes(profile, sources = [], nodes = []) {
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const { knownIds, selected } = resolveSourceScope(profile, sources);
  const include = compilePattern(profile.filter.include);
  const exclude = compilePattern(profile.filter.exclude);
  const protocols = new Set(profile.filter.protocols);
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
      const key = buildProxyNodeConnectionKey(node);
      if (seenConnections.has(key)) {
        stats.duplicates += 1;
        continue;
      }
      seenConnections.add(key);
    }

    const source = inSubscription ? sourceById.get(subscriptionId) : MANUAL_SOURCE;
    let baseName = applyRenames(originalName, profile.naming.renames).trim()
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
  stats.selected = entries.length;
  return { entries, stats };
}

module.exports = {
  MANUAL_SOURCE,
  detectRegion,
  flagCountryCode,
  selectAggregatedNodes
};
