'use strict';

// 自建分组 → 节点：把订阅聚合里的自建分组展开成节点库里的节点（出口池按分组选节点时用）。
//
// 与 aggregation-plan 同一套语义（单一事实来源是它们共用的 selectAggregatedNodes 与组定义）：
//   - 组的节点 = 勾选的节点名 ∪ 包含规则命中的节点 − 排除规则命中的节点；
//   - 组成员可以引用其它自建组 / 地区组 / 订阅源组，递归展开（成环的引用保存时已被拒绝，这里再防一次）；
//   - 节点名是聚合配置**输出后的名字**（含改名、来源前缀），所以先跑 selectAggregatedNodes。
// 内置策略成员（节点选择 / 自动 / 直连 / 拒绝）不是节点，忽略。

const { selectAggregatedNodes } = require('./node-selection');

function compile(pattern) {
  try {
    return pattern ? new RegExp(pattern, 'i') : null;
  } catch (_error) {
    return null;
  }
}

/**
 * @returns {Array<{ id: string, profileId: string, profileName: string, groupId: string, name: string, nodes: object[] }>}
 *   id = `<profileId>:<groupId>`；nodes 是节点库里的原始节点对象。
 */
function listAggregatorGroups(profiles, sources, nodes) {
  const out = [];
  (Array.isArray(profiles) ? profiles : []).forEach((profile) => {
    const custom = (profile && profile.groups && profile.groups.custom) || [];
    if (custom.length === 0) return;
    const { entries } = selectAggregatedNodes(profile, sources, nodes);
    const byId = new Map(custom.map((group) => [group.id, group]));
    const expand = (group, seen) => {
      if (seen.has(group.id)) return [];
      seen.add(group.id);
      const picked = new Set(group.nodes.names || []);
      const include = compile(group.nodes.include);
      const exclude = compile(group.nodes.exclude);
      const direct = entries.filter((entry) => (picked.has(entry.name) || (include && include.test(entry.name)))
        && !(exclude && exclude.test(entry.name)));
      const viaMembers = (group.members || []).flatMap((member) => {
        const [kind, id] = [member.slice(0, member.indexOf(':')), member.slice(member.indexOf(':') + 1)];
        if (kind === 'group' && byId.has(id)) return expand(byId.get(id), seen);
        if (kind === 'region') return entries.filter((entry) => entry.region && entry.region.id === id);
        if (kind === 'source') return entries.filter((entry) => entry.sourceId === id);
        return [];
      });
      return [...direct, ...viaMembers];
    };
    custom.forEach((group) => {
      const unique = new Map();
      expand(group, new Set()).forEach((entry) => unique.set(entry.node, entry.node));
      out.push({
        id: `${profile.id}:${group.id}`,
        profileId: profile.id,
        profileName: profile.name,
        groupId: group.id,
        name: group.name,
        nodes: [...unique.values()]
      });
    });
  });
  return out;
}

module.exports = { listAggregatorGroups };
