'use strict';

// 账号级异常协议防腐层：只观察上游错误，不扫描请求、正常输出或凭据。
const ERROR_RULES_ENV_KEY = 'AIH_UPSTREAM_ERROR_RULES';
const ERROR_RULE_KINDS = Object.freeze([
  'billing_blocked', 'quota_exhausted', 'auth_invalid',
  'permission_denied', 'rate_limited', 'service_unavailable'
]);
const ERROR_RULE_FIELDS = new Set(['code', 'type', 'message', 'body']);
const ERROR_RULE_SOURCES = new Set(['http_code', 'body', 'json']);
const ERROR_RULE_OPERATORS = new Set(['regex', 'contains', 'equals']);
const ERROR_RULE_GROUP_IDS_ENV_KEY = 'AIH_UPSTREAM_ERROR_GROUP_IDS';
const MAX_ERROR_BYTES = 64 * 1024;

function invalid(message) {
  const error = new Error(message);
  error.code = 'invalid_upstream_error_rules';
  throw error;
}

function compilePattern(pattern) {
  // 同步热路径仅支持线性基础正则：禁止分组/反向引用，每分支最多一个量词。
  // 精确错误码、字符类、锚点和文案候选都可表达，避免配置拖住网关事件循环。
  if (typeof pattern !== 'string' || !pattern || pattern.length > 256) invalid('正则长度须为 1–256');
  const atoms = pattern.replace(/\\[^1-9]/g, 'x').replace(/\[[^\]]*\]/g, 'x');
  if (/[()]/.test(atoms) || /\\[1-9]/.test(pattern)
    || atoms.split('|').some(branch => (branch.match(/[+*?{]/g) || []).length > 1)
    || /\{/.test(atoms)) invalid('正则支持锚点、字符类、候选分支，每个分支最多一个基础量词；不支持分组和反向引用');
  for (const branch of atoms.split('|')) {
    const repeated = branch.search(/[+*]/);
    // 无起点锚定的 a+b 在不匹配的长文本上会反复扫描后缀，仍有平方复杂度。
    if (repeated >= 0 && branch.slice(repeated + 1) && !branch.startsWith('^')) {
      invalid('带重复量词和后续内容的分支须以 ^ 锚定；包含匹配请直接填写关键词');
    }
  }
  try { return new RegExp(pattern, 'iu'); } catch (_error) { return invalid('正则表达式无效'); }
}

function normalizeJsonPath(path) {
  const value = String(path == null ? '' : path).trim();
  if (!value || value.length > 256 || value.startsWith('.') || value.endsWith('.') || value.includes('..')) {
    invalid('JSON 路径须为 1–256 字符的点路径');
  }
  const segments = value.replace(/\[([0-9]+)\]/g, '.$1').split('.');
  if (segments.length > 16 || segments.some((segment) => !/^(?:[A-Za-z_$][A-Za-z0-9_$]*|[0-9]+)$/.test(segment))) {
    invalid('JSON 路径只支持对象键和数组下标');
  }
  return segments;
}

function normalizeMatcherValue(value) {
  if (value === undefined) invalid('请输入匹配值');
  if (value == null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    if (typeof value === 'string' && value.length > 4096) invalid('匹配值不能超过 4096 字符');
    if (typeof value === 'number' && !Number.isFinite(value)) invalid('匹配值必须是有限数字');
    return value;
  }
  invalid('匹配值必须是字符串、数字、布尔值或 null');
}

function normalizeRuleMatcher(matcher) {
  if (!matcher || typeof matcher !== 'object' || Array.isArray(matcher)) invalid('错误匹配条件格式无效');
  // 旧版账号规则的公开格式保持原样，避免保存一次就产生无意义的配置 diff。
  if (matcher.field != null || matcher.pattern != null) {
    if (!ERROR_RULE_FIELDS.has(matcher.field)) invalid('错误字段须为 code、type、message 或 body');
    compilePattern(matcher.pattern);
    return { field: matcher.field, pattern: matcher.pattern };
  }
  const source = String(matcher.source || '').trim().toLowerCase();
  const operator = String(matcher.operator || '').trim().toLowerCase();
  if (!ERROR_RULE_SOURCES.has(source)) invalid('匹配来源须为 http_code、body 或 json');
  if (!ERROR_RULE_OPERATORS.has(operator)) invalid('匹配方式须为 regex、contains 或 equals');
  const normalized = {
    source,
    operator,
    ...(source === 'json' ? { path: String(matcher.path || '').trim() } : {}),
    value: normalizeMatcherValue(matcher.value)
  };
  if (source === 'json') normalizeJsonPath(normalized.path);
  if (operator === 'regex') compilePattern(String(normalized.value == null ? '' : normalized.value));
  if (source === 'http_code' && operator === 'equals') {
    const code = Number(normalized.value);
    if (!Number.isInteger(code) || code < 100 || code > 599) invalid('HTTP 状态码须为 100–599 的整数');
    normalized.value = code;
  }
  return normalized;
}

function validateUpstreamErrorRules(value) {
  if (!Array.isArray(value) || value.length > 20) invalid('异常规则须为数组，最多 20 条');
  return value.map((rule, index) => {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) invalid(`规则 ${index + 1} 格式无效`);
    if (!ERROR_RULE_KINDS.includes(rule.kind)) invalid(`规则 ${index + 1} 的目标状态无效`);
    if (rule.enabled != null && typeof rule.enabled !== 'boolean') invalid('enabled 须为布尔值');
    const name = rule.name == null ? '' : String(rule.name).trim();
    if (name.length > 80) invalid('规则名称不能超过 80 字');
    const statuses = rule.statuses == null ? [] : rule.statuses;
    if (!Array.isArray(statuses) || statuses.length > 20
      || statuses.some(status => !Number.isInteger(status) || status < 400 || status > 599)) invalid('状态码须为 400–599 的整数数组');
    if (!Array.isArray(rule.matchers) || !rule.matchers.length || rule.matchers.length > 8) invalid('每条规则须有 1–8 个错误匹配条件');
    const matchers = rule.matchers.map(normalizeRuleMatcher);
    return { name, enabled: rule.enabled !== false, statuses: [...new Set(statuses)], matchers, kind: rule.kind };
  });
}

function readUpstreamErrorRules(env) {
  return readEffectiveUpstreamErrorRules(env, {});
}

function readUpstreamErrorGroupIds(env) {
  const raw = env && env[ERROR_RULE_GROUP_IDS_ENV_KEY];
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return [...new Set(value.map((id) => String(id || '').trim()).filter((id) => /^[A-Za-z0-9_-]{1,64}$/.test(id)))].slice(0, 20);
  } catch (_error) {
    return [];
  }
}

function readEffectiveUpstreamErrorRules(env, options = {}) {
  const raw = env && env[ERROR_RULES_ENV_KEY];
  let direct = [];
  if (raw) {
    try { direct = validateUpstreamErrorRules(JSON.parse(raw)); } catch (_error) { direct = []; }
  }
  const configuredGroups = Array.isArray(options.groups)
    ? options.groups
    : (options.groups && Array.isArray(options.groups.groups) ? options.groups.groups : []);
  const provider = String(options.provider || '').trim().toLowerCase();
  const groupsById = new Map(
    configuredGroups
      .filter((group) => group && group.enabled !== false)
      .filter((group) => !provider || !group.provider || group.provider === 'all'
        || String(group.provider).trim().toLowerCase() === provider)
      .map((group) => [String(group.id || '').trim(), group])
  );
  const grouped = [];
  for (const id of readUpstreamErrorGroupIds(env)) {
    const group = groupsById.get(id);
    if (!group || !Array.isArray(group.rules)) continue;
    try { grouped.push(...validateUpstreamErrorRules(group.rules)); } catch (_error) {}
  }
  return [...grouped, ...direct];
}

function errorObservation(statusCode, body) {
  let text = '';
  let payload = body;
  if (typeof body === 'string' || Buffer.isBuffer(body)) {
    text = String(body).slice(0, MAX_ERROR_BYTES);
    try { payload = JSON.parse(text); } catch (_error) { payload = null; }
  }
  const structured = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;
  const explicitFailure = structured && ['error', 'response.failed'].includes(structured.type);
  const failedHTTP = Number(statusCode) >= 400 && Number(statusCode) <= 599;
  if (!failedHTTP && !explicitFailure) return null;
  const error = structured && (structured.response?.error || structured.error
    || structured.response?.last_error || structured.last_error || structured.detail || structured);
  if (!text && structured) text = JSON.stringify(structured).slice(0, MAX_ERROR_BYTES);
  return {
    httpCode: Number(statusCode) || 0,
    code: String(error?.code || '').slice(0, 1024),
    type: String(error?.type || '').slice(0, 1024),
    message: String(typeof error === 'string' ? error : error?.message || '').slice(0, 4096),
    body: text.slice(0, 8192),
    json: structured || payload
  };
}

function readJsonPath(value, path) {
  let current = value;
  for (const segment of normalizeJsonPath(path)) {
    if (current == null || (typeof current !== 'object' && !Array.isArray(current))) return undefined;
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
    current = current[segment];
  }
  return current;
}

function valuesEqual(actual, expected) {
  if (actual === expected) return true;
  if (actual == null || expected == null) return false;
  if (typeof expected === 'number') return Number(actual) === expected;
  return String(actual) === String(expected);
}

function matchStructuredMatcher(matcher, observation) {
  if (matcher.field) return compilePattern(matcher.pattern).test(observation[matcher.field] || '');
  const value = matcher.source === 'http_code'
    ? observation.httpCode
    : matcher.source === 'json'
      ? readJsonPath(observation.json, matcher.path)
      : observation.body;
  if (matcher.operator === 'equals') return valuesEqual(value, matcher.value);
  if (matcher.operator === 'contains') return String(value == null ? '' : value).includes(String(matcher.value));
  return compilePattern(String(matcher.value == null ? '' : matcher.value)).test(String(value == null ? '' : value));
}

function matchUpstreamErrorRule(rules, statusCode, body) {
  if (!Array.isArray(rules) || !rules.length) return null;
  const observation = errorObservation(statusCode, body);
  if (!observation) return null;
  for (const rule of rules) {
    if (rule.enabled === false || (rule.statuses.length && !rule.statuses.includes(Number(statusCode)))) continue;
    if (rule.matchers.every(matcher => matchStructuredMatcher(matcher, observation))) return rule;
  }
  return null;
}

module.exports = {
  ERROR_RULES_ENV_KEY, ERROR_RULE_GROUP_IDS_ENV_KEY, ERROR_RULE_KINDS, ERROR_RULE_SOURCES, ERROR_RULE_OPERATORS,
  validateUpstreamErrorRules, readUpstreamErrorRules, readUpstreamErrorGroupIds,
  readEffectiveUpstreamErrorRules, matchUpstreamErrorRule
};
