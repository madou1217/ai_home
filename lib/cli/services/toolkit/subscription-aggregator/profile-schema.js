'use strict';

const crypto = require('node:crypto');
const net = require('node:net');
const {
  BUILTIN_POLICIES,
  DEFAULT_EXCLUDE_PATTERN,
  DEFAULT_TEST_URL,
  GROUP_NAMES,
  POLICY_PROXY,
  REGIONS,
  REGION_BY_ID,
  RULE_PRESETS,
  RULE_PRESET_BY_ID
} = require('./catalog');

const CUSTOM_RULE_TYPES = Object.freeze(['DOMAIN', 'DOMAIN-SUFFIX', 'DOMAIN-KEYWORD', 'IP-CIDR', 'GEOSITE', 'GEOIP']);
// 自建策略组的策略：手动选择 / 延迟最低 / 故障转移（按顺序用第一个可用的）/ 负载均衡。
const CUSTOM_GROUP_TYPES = Object.freeze(['select', 'url-test', 'fallback', 'load-balance']);
const LOAD_BALANCE_STRATEGIES = Object.freeze(['consistent-hashing', 'round-robin']);
const MAX_PATTERN_LENGTH = 500;
const MAX_CUSTOM_RULES = 500;
const MAX_CUSTOM_GROUPS = 50;
const MAX_GROUP_MEMBERS = 100;
const MAX_GROUP_NODE_NAMES = 500;
const MAX_RENAMES = 50;
const MAX_NAME_LENGTH = 64;
const GROUP_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
// 自建组名会出现在 Surge / Loon / QX 以逗号、等号分隔的行里：清洗后可能和别的组撞名，直接不允许。
const GROUP_NAME_FORBIDDEN = /[,=\u0000-\u001f\u007f]/;

function profileError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizeName(value, fallback) {
  const text = String(value ?? '').trim().slice(0, MAX_NAME_LENGTH);
  return text || fallback;
}

function normalizePattern(value, field) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (text.length > MAX_PATTERN_LENGTH) throw profileError('invalid_aggregator_pattern', `invalid_aggregator_pattern_${field}`);
  try {
    new RegExp(text, 'i');
  } catch (_error) {
    throw profileError('invalid_aggregator_pattern', `invalid_aggregator_pattern_${field}`);
  }
  return text;
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => String(value || '').trim()).filter(Boolean))];
}

/**
 * 策略引用：内置策略，或 region: / source: / preset: / group:（自建组）前缀引用；
 * 引用的组是否还在交给聚合规划（找不到时回落到节点选择并给出警告）。
 * allowPreset=false 用于自建组成员：自建组不能引用预设组（预设组本身会引用自建组，会成环）。
 */
function normalizePolicy(value, fallback = POLICY_PROXY, { allowPreset = true } = {}) {
  const text = String(value ?? '').trim();
  if (!text) return fallback;
  if (BUILTIN_POLICIES.includes(text)) return text;
  const [kind, id] = [text.slice(0, text.indexOf(':')), text.slice(text.indexOf(':') + 1)];
  if (kind === 'region' && REGION_BY_ID.has(id)) return text;
  if (kind === 'preset' && allowPreset && RULE_PRESET_BY_ID.has(id)) return text;
  if ((kind === 'source' || kind === 'group') && GROUP_ID_PATTERN.test(id)) return text;
  throw profileError('invalid_aggregator_policy', `invalid_aggregator_policy_${text}`);
}

function isValidCidr(value) {
  const [address, prefixText, extra] = String(value).split('/');
  if (extra !== undefined) return false;
  const family = net.isIP(address);
  if (!family) return false;
  if (prefixText === undefined) return true;
  if (!/^\d{1,3}$/.test(prefixText)) return false;
  return Number(prefixText) <= (family === 4 ? 32 : 128);
}

function normalizeRuleValue(type, rawValue) {
  const value = String(rawValue ?? '').trim();
  const invalid = () => profileError('invalid_aggregator_rule', `invalid_aggregator_rule_${type}`);
  if (!value || value.length > 253 || /[\s,]/.test(value)) throw invalid();
  if (type === 'DOMAIN' || type === 'DOMAIN-SUFFIX') {
    const domain = value.toLowerCase().replace(/^\./, '');
    if (!/^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/.test(domain)) throw invalid();
    return domain;
  }
  if (type === 'DOMAIN-KEYWORD') return value.toLowerCase();
  if (type === 'IP-CIDR') {
    if (!isValidCidr(value)) throw invalid();
    return value.includes('/') ? value : `${value}/${net.isIP(value) === 4 ? 32 : 128}`;
  }
  if (!/^[a-z0-9!@._-]+$/i.test(value)) throw invalid();
  return value.toLowerCase();
}

function normalizeCustomRules(rules) {
  const list = Array.isArray(rules) ? rules : [];
  if (list.length > MAX_CUSTOM_RULES) throw profileError('too_many_aggregator_rules');
  return list.map((rawRule) => {
    const rule = plainObject(rawRule);
    const type = String(rule.type || '').trim().toUpperCase();
    if (!CUSTOM_RULE_TYPES.includes(type)) throw profileError('invalid_aggregator_rule', `invalid_aggregator_rule_type_${type || 'empty'}`);
    return {
      type,
      value: normalizeRuleValue(type, rule.value),
      policy: normalizePolicy(rule.policy)
    };
  });
}

/** 预设按目录顺序输出；未出现在输入里的预设取目录默认值，未知预设丢弃。 */
function normalizePresets(presets) {
  const byId = new Map((Array.isArray(presets) ? presets : [])
    .map((entry) => plainObject(entry))
    .filter((entry) => RULE_PRESET_BY_ID.has(entry.id))
    .map((entry) => [entry.id, entry]));
  return RULE_PRESETS.map((preset) => {
    const entry = byId.get(preset.id);
    return {
      id: preset.id,
      enabled: entry ? entry.enabled === true : preset.enabledByDefault,
      policy: normalizePolicy(entry?.policy, preset.defaultPolicy)
    };
  });
}

function normalizeRenames(renames) {
  const list = Array.isArray(renames) ? renames : [];
  if (list.length > MAX_RENAMES) throw profileError('too_many_aggregator_renames');
  return list
    .map((entry) => plainObject(entry))
    .map((entry) => ({
      pattern: normalizePattern(entry.pattern, 'rename'),
      replace: String(entry.replace ?? '').slice(0, MAX_NAME_LENGTH)
    }))
    .filter((entry) => entry.pattern);
}

// 自动生成的组名：自建组不能重名（同名组会让客户端拒绝整份配置）。
const RESERVED_GROUP_NAMES = new Set([
  ...Object.values(GROUP_NAMES),
  ...RULE_PRESETS.map((preset) => preset.name),
  ...REGIONS.map((region) => `${region.flag} ${region.name}节点`)
]);

function newGroupId(taken) {
  let id;
  do {
    id = `grp_${crypto.randomBytes(4).toString('hex')}`;
  } while (taken.has(id));
  return id;
}

/** 自建组互相套用不能成环，也不能引用不存在的组（客户端遇到都会拒绝整份配置）。 */
function assertGroupsAcyclic(groups) {
  const byId = new Map(groups.map((group) => [group.id, group]));
  const state = new Map();
  const visit = (group, trail) => {
    if (state.get(group.id) === 'done') return;
    if (state.get(group.id) === 'visiting') {
      throw profileError('invalid_aggregator_group_cycle', `invalid_aggregator_group_cycle_${[...trail, group.name].join('>')}`);
    }
    state.set(group.id, 'visiting');
    for (const member of group.members) {
      if (!member.startsWith('group:')) continue;
      const target = byId.get(member.slice('group:'.length));
      if (!target) throw profileError('invalid_aggregator_group_member', `invalid_aggregator_group_member_${member}`);
      visit(target, [...trail, group.name]);
    }
    state.set(group.id, 'done');
  };
  groups.forEach((group) => visit(group, []));
}

function normalizeCustomGroups(rawGroups) {
  const list = Array.isArray(rawGroups) ? rawGroups : [];
  if (list.length > MAX_CUSTOM_GROUPS) throw profileError('too_many_aggregator_groups');
  const ids = new Set();
  const names = new Set();
  const groups = list.map((raw, index) => {
    const group = plainObject(raw);
    const requestedId = String(group.id ?? '').trim();
    const id = GROUP_ID_PATTERN.test(requestedId) && !ids.has(requestedId) ? requestedId : newGroupId(ids);
    ids.add(id);
    const name = normalizeName(group.name, `策略组 ${index + 1}`);
    if (GROUP_NAME_FORBIDDEN.test(name)) throw profileError('invalid_aggregator_group_name', `invalid_aggregator_group_name_${name}`);
    if (names.has(name) || RESERVED_GROUP_NAMES.has(name)) {
      throw profileError('duplicate_aggregator_group_name', `duplicate_aggregator_group_name_${name}`);
    }
    names.add(name);
    const type = CUSTOM_GROUP_TYPES.includes(group.type) ? group.type : 'select';
    const members = uniqueStrings(group.members);
    const nodes = plainObject(group.nodes);
    const nodeNames = uniqueStrings(nodes.names);
    if (members.length > MAX_GROUP_MEMBERS || nodeNames.length > MAX_GROUP_NODE_NAMES) {
      throw profileError('too_many_aggregator_group_members');
    }
    const normalized = {
      id,
      name,
      type,
      members: members.map((member) => normalizePolicy(member, POLICY_PROXY, { allowPreset: false })),
      nodes: {
        include: normalizePattern(nodes.include, 'group_include'),
        exclude: normalizePattern(nodes.exclude, 'group_exclude'),
        names: nodeNames.map((nodeName) => nodeName.slice(0, 256))
      }
    };
    // 测速地址 / 间隔留空表示沿用这份聚合配置的设置。
    if (type !== 'select') {
      normalized.testUrl = String(group.testUrl ?? '').trim() ? normalizeTestUrl(group.testUrl) : '';
      normalized.interval = Number(group.interval) > 0 ? clampInteger(group.interval, 300, 30, 86400) : 0;
    }
    if (type === 'url-test') normalized.tolerance = clampInteger(group.tolerance ?? 50, 50, 0, 5000);
    if (type === 'load-balance') {
      normalized.strategy = LOAD_BALANCE_STRATEGIES.includes(group.strategy) ? group.strategy : LOAD_BALANCE_STRATEGIES[0];
    }
    return normalized;
  });
  assertGroupsAcyclic(groups);
  return groups;
}

function normalizeTestUrl(value) {
  const text = String(value ?? '').trim();
  if (!text) return DEFAULT_TEST_URL;
  try {
    const url = new URL(text);
    if (['http:', 'https:'].includes(url.protocol)) return url.toString();
  } catch (_error) { /* fall through */ }
  throw profileError('invalid_aggregator_test_url');
}

function clampInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

/**
 * 规范化一份聚合配置。existing 提供 id/token/createdAt 等不可由客户端改写的字段。
 */
function normalizeProfile(input = {}, existing = null, now = Date.now()) {
  const source = plainObject(input);
  const sources = plainObject(source.sources);
  const filter = plainObject(source.filter);
  const naming = plainObject(source.naming);
  const groups = plainObject(source.groups);
  const rules = plainObject(source.rules);
  const regionIds = Array.isArray(groups.regions)
    ? uniqueStrings(groups.regions).filter((id) => REGION_BY_ID.has(id))
    : REGIONS.map((region) => region.id);

  return {
    id: existing?.id || String(source.id || ''),
    name: normalizeName(source.name, existing?.name || '聚合订阅'),
    token: existing?.token || '',
    sources: {
      all: sources.all !== false,
      subscriptionIds: uniqueStrings(sources.subscriptionIds),
      includeManualNodes: sources.includeManualNodes === true
    },
    filter: {
      include: normalizePattern(filter.include, 'include'),
      exclude: filter.exclude === undefined ? DEFAULT_EXCLUDE_PATTERN : normalizePattern(filter.exclude, 'exclude'),
      protocols: uniqueStrings(filter.protocols).map((protocol) => protocol.toLowerCase())
    },
    naming: {
      sourcePrefix: naming.sourcePrefix === true,
      renames: normalizeRenames(naming.renames)
    },
    dedupe: source.dedupe !== false,
    groups: {
      regions: regionIds,
      perSource: groups.perSource === true,
      testUrl: normalizeTestUrl(groups.testUrl),
      testIntervalSec: clampInteger(groups.testIntervalSec, 300, 30, 86400),
      custom: normalizeCustomGroups(groups.custom)
    },
    rules: {
      presets: normalizePresets(rules.presets),
      custom: normalizeCustomRules(rules.custom),
      finalPolicy: normalizePolicy(rules.finalPolicy)
    },
    refreshHours: clampInteger(source.refreshHours, 12, 0, 720),
    createdAt: existing?.createdAt || now,
    updatedAt: now
  };
}

module.exports = {
  CUSTOM_GROUP_TYPES,
  CUSTOM_RULE_TYPES,
  LOAD_BALANCE_STRATEGIES,
  RESERVED_GROUP_NAMES,
  normalizePolicy,
  normalizeProfile,
  profileError
};
