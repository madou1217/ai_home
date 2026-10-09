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
  const proxyGroup = {
    name: GROUP_NAMES[POLICY_PROXY],
    type: 'select',
    members: uniqueRefs([groupRef(autoGroup.name), ...childGroupRefs, DIRECT, ...nodeRefs])
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

  const optionRefs = [groupRef(proxyGroup.name), groupRef(autoGroup.name), ...childGroupRefs, DIRECT];
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

module.exports = {
  DIRECT,
  REJECT,
  buildAggregationPlan
};
