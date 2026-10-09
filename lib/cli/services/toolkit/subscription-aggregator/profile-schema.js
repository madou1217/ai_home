'use strict';

const net = require('node:net');
const {
  BUILTIN_POLICIES,
  DEFAULT_EXCLUDE_PATTERN,
  DEFAULT_TEST_URL,
  POLICY_PROXY,
  REGIONS,
  REGION_BY_ID,
  RULE_PRESETS,
  RULE_PRESET_BY_ID
} = require('./catalog');

const CUSTOM_RULE_TYPES = Object.freeze(['DOMAIN', 'DOMAIN-SUFFIX', 'DOMAIN-KEYWORD', 'IP-CIDR', 'GEOSITE', 'GEOIP']);
const MAX_PATTERN_LENGTH = 500;
const MAX_CUSTOM_RULES = 500;
const MAX_RENAMES = 50;
const MAX_NAME_LENGTH = 64;

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

/** 策略引用：内置策略，或 region:/source:/preset: 前缀引用；解析是否存在交给聚合规划。 */
function normalizePolicy(value, fallback = POLICY_PROXY) {
  const text = String(value ?? '').trim();
  if (!text) return fallback;
  if (BUILTIN_POLICIES.includes(text)) return text;
  const [kind, id] = [text.slice(0, text.indexOf(':')), text.slice(text.indexOf(':') + 1)];
  if (kind === 'region' && REGION_BY_ID.has(id)) return text;
  if (kind === 'preset' && RULE_PRESET_BY_ID.has(id)) return text;
  if (kind === 'source' && /^[A-Za-z0-9_-]{1,64}$/.test(id)) return text;
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
      testIntervalSec: clampInteger(groups.testIntervalSec, 300, 30, 86400)
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
  CUSTOM_RULE_TYPES,
  normalizePolicy,
  normalizeProfile,
  profileError
};
