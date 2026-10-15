'use strict';

// 账号自定义上游错误规则的 Go 投影（Node → Go 控制面）。
//
// Node 是规则与错误映射分组的唯一 owner：运行池里 account.upstreamErrorRules 就是该
// 账号的「有效规则」（账号直接规则 + 命中分组规则，见 account/upstream-error-rules）。
// 本模块把它整理成 Go 管理接口（PUT /v1/management/upstream-error-rules）的推送记录，
// 并把 Go 的接受结果换算回「哪些账号还必须继续由 Node 承接」。
//
// 只做形状整理与保守判定，不解释规则语义：识别在 account/upstream-error-rules，
// Go 侧的承接判定在 application/upstreamrules。任何无法忠实表达的账号一律不推送，
// 让它留在 Node（fail closed），而不是让 Go 用残缺规则集做出不同结论。

const RULE_KINDS = new Set([
  'billing_blocked', 'quota_exhausted', 'auth_invalid',
  'permission_denied', 'rate_limited', 'service_unavailable'
]);
const LEGACY_FIELDS = new Set(['code', 'type', 'message', 'body']);
const SOURCES = new Set(['http_code', 'body', 'json']);
const OPERATORS = new Set(['regex', 'contains', 'equals']);

/** 运行池里的账号是否带生效规则（停用规则不产生异常语义）。 */
function hasEnabledRules(account) {
  const rules = account && Array.isArray(account.upstreamErrorRules) ? account.upstreamErrorRules : [];
  return rules.some(rule => rule && rule.enabled !== false);
}

/** 整理单条匹配条件的线上形状；不可忠实表达时返回 null。 */
function projectMatcher(matcher) {
  if (!matcher || typeof matcher !== 'object' || Array.isArray(matcher)) return null;
  // 旧版 field/pattern 形态原样保留（与 Node 公开配置格式一致）。
  if (matcher.field != null || matcher.pattern != null) {
    if (!LEGACY_FIELDS.has(matcher.field)) return null;
    if (typeof matcher.pattern !== 'string' || !matcher.pattern) return null;
    return { field: matcher.field, pattern: matcher.pattern };
  }
  const source = String(matcher.source || '').trim().toLowerCase();
  const operator = String(matcher.operator || '').trim().toLowerCase();
  if (!SOURCES.has(source) || !OPERATORS.has(operator)) return null;
  const value = matcher.value;
  if (!(value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')) {
    return null;
  }
  if (source === 'json') {
    const path = String(matcher.path || '').trim();
    if (!path) return null;
    return { source, operator, path, value };
  }
  return { source, operator, value };
}

/** 整理单条规则的线上形状；不可忠实表达时返回 null。 */
function projectRule(rule) {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return null;
  const kind = String(rule.kind || '');
  if (!RULE_KINDS.has(kind)) return null;
  const rawStatuses = rule.statuses == null ? [] : rule.statuses;
  if (!Array.isArray(rawStatuses)) return null;
  const statuses = [];
  for (const status of rawStatuses) {
    if (!Number.isInteger(status) || status < 400 || status > 599) return null;
    if (!statuses.includes(status)) statuses.push(status);
  }
  if (!Array.isArray(rule.matchers) || !rule.matchers.length) return null;
  const matchers = [];
  for (const matcher of rule.matchers) {
    const projected = projectMatcher(matcher);
    if (!projected) return null;
    matchers.push(projected);
  }
  return {
    name: String(rule.name == null ? '' : rule.name),
    kind,
    // 显式下发 enabled，避免 Go 把缺省当停用。
    enabled: rule.enabled !== false,
    statuses,
    matchers
  };
}


/** 解析账号在 Go 侧的引用；未启用同步时两侧同 id，映射缺省即原样返回。 */
function resolveGoRef(accountRef, goRefFor) {
  if (typeof goRefFor !== 'function') return accountRef;
  return String(goRefFor(accountRef) || '').trim();
}

/** 整理单个账号的推送记录；没有 Go 侧引用或规则不可忠实表达时返回 null。 */
function projectAccount(account, options = {}) {
  const accountRef = String(account && account.accountRef || '').trim();
  if (!accountRef) return null;
  const provider = String(account && account.provider || '').trim().toLowerCase();
  if (!provider) return null;
  const rules = Array.isArray(account && account.upstreamErrorRules) ? account.upstreamErrorRules : [];
  const projected = [];
  for (const rule of rules) {
    const item = projectRule(rule);
    // 忠实性优先：一条无法表达的规则会让 Go 的规则集与 Node 不同（首个命中规则可能变），
    // 因此整个账号都不推送，继续由 Node 承接。
    if (!item) return null;
    projected.push(item);
  }
  const goRef = resolveGoRef(accountRef, options.goRefFor);
  if (!goRef) return null;
  return { account_ref: goRef, provider, rules: projected };
}

/**
 * 收集整份投影。
 *
 * 只推送带生效规则的账号：没有生效规则的账号本来就不会触发交还，Go 也不需要它的记录。
 * 顺序按 Node 账号引用排序，保证同一份规则表每次推送出同一份内容（内容未变时不重复 PUT）。
 */
function collectUpstreamErrorRulesProjection(pools, options = {}) {
  const byRef = new Map();
  for (const pool of Object.values(pools && typeof pools === 'object' ? pools : {})) {
    for (const account of Array.isArray(pool) ? pool : []) {
      const ref = String(account && account.accountRef || '').trim();
      if (!ref || byRef.has(ref) || !hasEnabledRules(account)) continue;
      byRef.set(ref, account);
    }
  }
  const accounts = [];
  const seenGoRefs = new Set();
  for (const ref of [...byRef.keys()].sort()) {
    const record = projectAccount(byRef.get(ref), options);
    if (!record) continue;
    // 身份合并后两个 Node 引用可能指向同一个 Go 账号：只保留一份，避免后写覆盖。
    if (seenGoRefs.has(record.account_ref)) continue;
    seenGoRefs.add(record.account_ref);
    accounts.push(record);
  }
  return accounts;
}

/** Node 账号引用是否已被 Go 承接（含同步 rekey 后的引用映射）。 */
function accountAcceptedByGo(accountRef, acceptedRefs, mapRef) {
  const ref = String(accountRef || '').trim();
  if (!ref || !(acceptedRefs instanceof Set) || acceptedRefs.size === 0) return false;
  if (acceptedRefs.has(ref)) return true;
  if (typeof mapRef !== 'function') return false;
  const goRef = String(mapRef(ref) || '').trim();
  return Boolean(goRef) && acceptedRefs.has(goRef);
}

/**
 * 逐个枚举「带生效规则且 Go 尚未承接」的账号。
 *
 * 未钉选请求可能跨 Provider / 别名回落到池里任意账号，所以按整个运行池枚举：只要有一个
 * 带生效规则的账号没被 Go 承接，请求就必须交还 Node。acceptedRefs 为空集合（含 Go 尚未
 * 就绪、推送失败或 Go 未接入任何 Provider）时视为全部未承接。
 *
 * 这里同时是「开关打开了但一条流量都过不去」的唯一原因清单：交还判定的布尔用法见
 * hasUnacceptedEnabledRules，可观测用法见 go-core-host 的 /readyz 投影。
 */
function* iterateUnacceptedEnabledRuleAccounts(pools, acceptedRefs, mapRef) {
  const byProvider = pools && typeof pools === 'object' ? pools : {};
  for (const [poolProvider, pool] of Object.entries(byProvider)) {
    for (const account of Array.isArray(pool) ? pool : []) {
      if (!hasEnabledRules(account)) continue;
      if (accountAcceptedByGo(account && account.accountRef, acceptedRefs, mapRef)) continue;
      yield {
        accountRef: String(account && account.accountRef || '').trim(),
        // 运行池通常不带 provider 字段（Provider 就是池键），两者都读，池键兜底。
        provider: String(account && account.provider || poolProvider || '').trim().toLowerCase()
      };
    }
  }
}

/** 上述枚举的数组形态：交还原因的完整清单（Go 未承接的账号）。 */
function listUnacceptedEnabledRuleAccounts(pools, acceptedRefs, mapRef) {
  return [...iterateUnacceptedEnabledRuleAccounts(pools, acceptedRefs, mapRef)];
}

/**
 * 运行池里是否存在「带生效规则且 Go 尚未承接」的账号。
 *
 * 与 listUnacceptedEnabledRuleAccounts 共用同一份枚举逻辑：布尔判定不能有自己的
 * 判定分支，否则 /readyz 报出来的原因清单会和实际交还行为对不上。
 */
function hasUnacceptedEnabledRules(pools, acceptedRefs, mapRef) {
  return iterateUnacceptedEnabledRuleAccounts(pools, acceptedRefs, mapRef).next().done === false;
}

module.exports = {
  RULE_KINDS,
  accountAcceptedByGo,
  collectUpstreamErrorRulesProjection,
  hasEnabledRules,
  hasUnacceptedEnabledRules,
  iterateUnacceptedEnabledRuleAccounts,
  listUnacceptedEnabledRuleAccounts,
  projectAccount,
  projectMatcher,
  projectRule
};
