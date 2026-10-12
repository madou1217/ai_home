'use strict';

const {
  GROUP_NAMES,
  POLICY_AUTO,
  POLICY_DIRECT,
  POLICY_PROXY,
  POLICY_REJECT,
  PRIVATE_RULE_SETS,
  REGIONS,
  RULE_PRESET_BY_ID,
  ruleSetTag
} = require('./catalog');

const DIRECT = Object.freeze({ kind: 'direct' });
const REJECT = Object.freeze({ kind: 'reject' });

function groupRef(name) {
  return { kind: 'group', name };
}

function refKey(ref) {
  return ref.kind === 'group' || ref.kind === 'node' ? `${ref.kind}:${ref.name}` : ref.kind;
}

function uniqueRefs(refs) {
  const seen = new Set();
  return refs.filter((ref) => {
    const key = refKey(ref);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const CUSTOM_MATCHERS = Object.freeze({
  DOMAIN: 'domain',
  'DOMAIN-SUFFIX': 'domain-suffix',
  'DOMAIN-KEYWORD': 'domain-keyword',
  'IP-CIDR': 'ip-cidr'
});

/**
 * 内核中立的聚合规划：节点 → 策略组（地区/订阅源/自动/节点选择/预设/漏网之鱼）→ 分流规则。
 * capabilities.rejectInGroups=false 的目标（sing-box）里拒绝只能是规则动作，不能是组成员。
 */
function buildAggregationPlan(profile, selection, sources = [], capabilities = {}) {
  const rejectInGroups = capabilities.rejectInGroups !== false;
  const warnings = [];
  const entries = selection.entries || [];
  const nodeRefs = entries.map((entry) => ({ kind: 'node', name: entry.name }));
  if (!entries.length) warnings.push('aggregator_no_nodes');
  const urlTest = { testUrl: profile.groups.testUrl, interval: profile.groups.testIntervalSec };

  const regionGroups = new Map();
  for (const region of REGIONS) {
    if (!profile.groups.regions.includes(region.id)) continue;
    const members = entries.filter((entry) => entry.region?.id === region.id)
      .map((entry) => ({ kind: 'node', name: entry.name }));
    if (members.length) {
      regionGroups.set(region.id, { name: `${region.flag} ${region.name}节点`, type: 'url-test', members, ...urlTest });
    }
  }

  const sourceGroups = new Map();
  if (profile.groups.perSource) {
    for (const entry of entries) {
      if (!sourceGroups.has(entry.sourceId)) {
        // 组名会出现在逗号分隔的规则行里，订阅名中的逗号要去掉。
        const label = String(entry.sourceName).replace(/,/g, ' ');
        sourceGroups.set(entry.sourceId, { name: `📦 ${label}`, type: 'url-test', members: [], ...urlTest });
      }
      sourceGroups.get(entry.sourceId).members.push({ kind: 'node', name: entry.name });
    }
  }

  const autoGroup = { name: GROUP_NAMES[POLICY_AUTO], type: 'url-test', members: nodeRefs.length ? nodeRefs : [DIRECT], ...urlTest };
  const childGroupRefs = [...regionGroups.values(), ...sourceGroups.values()].map((group) => groupRef(group.name));

  // 自建组：名字与订阅源组或节点撞了就加后缀（客户端里组和节点共用名字空间；其它生成组的名字保存时已禁止使用）。
  const customGroups = profile.groups.custom || [];
  const customById = new Map(customGroups.map((group) => [group.id, group]));
  const takenNames = new Set([...[...regionGroups.values(), ...sourceGroups.values()].map((group) => group.name), ...entries.map((entry) => entry.name)]);
  const customNames = new Map(customGroups.map((group) => {
    let name = group.name;
    for (let counter = 2; takenNames.has(name); counter += 1) name = `${group.name} ${counter}`;
    takenNames.add(name);
    return [group.id, name];
  }));
  // （间接）用到「节点选择」的自建组不能再放进节点选择（会成环）。
  const proxyDependency = new Map();
  const dependsOnProxy = (group) => {
    if (proxyDependency.has(group.id)) return proxyDependency.get(group.id);
    proxyDependency.set(group.id, false);
    const result = group.members.some((member) => member === POLICY_PROXY || (member.startsWith('group:')
      && customById.has(member.slice('group:'.length)) && dependsOnProxy(customById.get(member.slice('group:'.length)))));
    proxyDependency.set(group.id, result);
    return result;
  };
  const customRefs = customGroups.map((group) => groupRef(customNames.get(group.id)));
  const proxySafeCustomRefs = customGroups.filter((group) => !dependsOnProxy(group)).map((group) => groupRef(customNames.get(group.id)));

  const proxyGroup = {
    name: GROUP_NAMES[POLICY_PROXY],
    type: 'select',
    members: uniqueRefs([groupRef(autoGroup.name), ...proxySafeCustomRefs, ...childGroupRefs, DIRECT, ...nodeRefs])
  };

  const presetGroups = new Map();
  const enabledPresets = profile.rules.presets.filter((preset) => preset.enabled && RULE_PRESET_BY_ID.has(preset.id));

  // 策略引用 → 规划内的目标。allowPreset 只给自定义规则用：组成员引用预设组可能成环。
  function resolvePolicy(policy, context, allowPreset = false) {
    if (policy === POLICY_PROXY) return groupRef(proxyGroup.name);
    if (policy === POLICY_AUTO) return groupRef(autoGroup.name);
    if (policy === POLICY_DIRECT) return DIRECT;
    if (policy === POLICY_REJECT) return REJECT;
    const separator = policy.indexOf(':');
    const kind = policy.slice(0, separator);
    const id = policy.slice(separator + 1);
    if (kind === 'group' && customNames.has(id)) return groupRef(customNames.get(id));
    const group = kind === 'region' ? regionGroups.get(id)
      : kind === 'source' ? sourceGroups.get(id)
        : kind === 'preset' && allowPreset ? presetGroups.get(id)
          : null;
    if (group) return groupRef(group.name);
    if (kind === 'preset' && allowPreset && enabledPresets.some((preset) => preset.id === id && preset.policy === POLICY_REJECT)) {
      return REJECT;
    }
    warnings.push(`aggregator_policy_fallback:${context}:${policy}`);
    return groupRef(proxyGroup.name);
  }

  // 自建组成员解析不到时直接去掉（不像规则那样回落到节点选择：这个组可能就在节点选择里，回落会成环）。
  function resolveGroupMember(member, group) {
    if ([POLICY_PROXY, POLICY_AUTO, POLICY_DIRECT, POLICY_REJECT].includes(member)) return resolvePolicy(member, '');
    const kind = member.slice(0, member.indexOf(':'));
    const id = member.slice(member.indexOf(':') + 1);
    const target = kind === 'group' ? customNames.get(id)
      : kind === 'region' ? regionGroups.get(id)?.name
        : kind === 'source' ? sourceGroups.get(id)?.name
          : '';
    if (target) return groupRef(target);
    warnings.push(`aggregator_group_member_missing:${group.name}:${member}`);
    return null;
  }

  // 自建组的成员：引用的组 / 内置策略在前，再加上按名称规则选入或勾选的节点；一个都没有时用直连占位。
  const customGroupPlans = customGroups.map((group) => {
    const include = group.nodes.include ? new RegExp(group.nodes.include, 'i') : null;
    const exclude = group.nodes.exclude ? new RegExp(group.nodes.exclude, 'i') : null;
    const picked = new Set(group.nodes.names);
    const nodes = entries
      .filter((entry) => picked.has(entry.name) || (include && include.test(entry.name)))
      .filter((entry) => !(exclude && exclude.test(entry.name)))
      .map((entry) => ({ kind: 'node', name: entry.name }));
    const resolved = group.members.map((member) => resolveGroupMember(member, group)).filter(Boolean);
    const members = uniqueRefs([...resolved, ...nodes]);
    // 目标格式不支持的策略（sing-box 没有故障转移 / 负载均衡）降级成延迟最低，并在预览里说明。
    let type = group.type;
    if (Array.isArray(capabilities.groupTypes) && !capabilities.groupTypes.includes(type)) {
      warnings.push(`aggregator_group_type_degraded:${customNames.get(group.id)}:${type}`);
      type = 'url-test';
    }
    const plan = { name: customNames.get(group.id), type, members: members.length ? members : [DIRECT] };
    if (type !== 'select') {
      plan.testUrl = group.testUrl || urlTest.testUrl;
      plan.interval = group.interval || urlTest.interval;
    }
    if (type === 'url-test') plan.tolerance = group.tolerance ?? 50;
    if (type === 'load-balance') plan.strategy = group.strategy;
    return plan;
  });

  const optionRefs = [groupRef(proxyGroup.name), groupRef(autoGroup.name), ...customRefs, ...childGroupRefs, DIRECT];
  for (const preset of enabledPresets) {
    const catalog = RULE_PRESET_BY_ID.get(preset.id);
    const preferred = resolvePolicy(preset.policy, `preset:${preset.id}`);
    if (preferred.kind === 'reject' && !rejectInGroups) continue;
    const members = uniqueRefs([preferred, ...optionRefs, ...(rejectInGroups ? [REJECT] : [])]);
    presetGroups.set(preset.id, { name: catalog.name, type: 'select', members });
  }

  const finalGroup = {
    name: GROUP_NAMES.final,
    type: 'select',
    members: uniqueRefs([resolvePolicy(profile.rules.finalPolicy, 'final'), ...optionRefs])
  };

  const ruleSets = new Map();
  const rules = [];
  const addRuleSetRule = (ruleSet, target) => {
    const tag = ruleSetTag(ruleSet);
    if (!ruleSets.has(tag)) ruleSets.set(tag, { tag, kind: ruleSet.kind, name: ruleSet.name });
    rules.push({ match: { type: 'rule-set', value: tag }, target, noResolve: ruleSet.noResolve === true || ruleSet.kind === 'geoip' });
  };

  for (const ruleSet of PRIVATE_RULE_SETS) addRuleSetRule(ruleSet, DIRECT);
  for (const custom of profile.rules.custom) {
    const target = resolvePolicy(custom.policy, `rule:${custom.type},${custom.value}`, true);
    if (custom.type === 'GEOSITE' || custom.type === 'GEOIP') {
      addRuleSetRule({ kind: custom.type.toLowerCase(), name: custom.value, noResolve: custom.type === 'GEOIP' }, target);
    } else {
      rules.push({ match: { type: CUSTOM_MATCHERS[custom.type], value: custom.value }, target, noResolve: custom.type === 'IP-CIDR' });
    }
  }
  for (const preset of enabledPresets) {
    const group = presetGroups.get(preset.id);
    const target = group ? groupRef(group.name) : REJECT;
    for (const ruleSet of RULE_PRESET_BY_ID.get(preset.id).ruleSets) addRuleSetRule(ruleSet, target);
  }

  const groups = [
    proxyGroup,
    autoGroup,
    ...customGroupPlans,
    ...presetGroups.values(),
    finalGroup,
    ...regionGroups.values(),
    ...sourceGroups.values()
  ].map((group) => ({
    ...group,
    members: rejectInGroups ? group.members : group.members.filter((member) => member.kind !== 'reject')
  }));

  return {
    nodes: entries,
    groups,
    rules,
    ruleSets: [...ruleSets.values()],
    final: groupRef(finalGroup.name),
    warnings: [...new Set(warnings)],
    stats: {
      ...(selection.stats || {}),
      groups: groups.length,
      regions: regionGroups.size,
      rules: rules.length + 1
    }
  };
}

/**
 * 把组成员里引用的其它组逐层展开成节点（直连 / 拒绝原样保留）。Surge 系、Loon、QX 的自动测速类
 * 策略组是否接受嵌套组没有把握，这些格式输出 url-test / fallback / load-balance 时用它。
 */
function flattenGroupMembers(groups, group) {
  const byName = new Map(groups.map((item) => [item.name, item]));
  const visited = new Set([group.name]);
  const result = [];
  const visit = (members) => {
    for (const member of members) {
      if (member.kind !== 'group') {
        result.push(member);
        continue;
      }
      const target = byName.get(member.name);
      if (!target || visited.has(target.name)) continue;
      visited.add(target.name);
      visit(target.members);
    }
  };
  visit(group.members);
  return uniqueRefs(result);
}

module.exports = {
  DIRECT,
  REJECT,
  buildAggregationPlan,
  flattenGroupMembers
};
