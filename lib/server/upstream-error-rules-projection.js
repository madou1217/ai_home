'use strict';

// 账号自定义上游错误规则的导入投影（Node → Go 管理接口）。
//
// 运行期规则权威在 Go：宿主不再推送规则，也不再按「Go 是否已承接」决定请求归属。
// 本模块只剩一处用途——历史导入脚本（scripts/import-account-upstream-error-rules.js）
// 把 Node 旧配置整理成账号级 Go 管理接口
// （PUT /v1/management/accounts/{ref}/upstream-error-rules）的请求记录。
//
// 只做形状整理，不解释规则语义：识别在 account/upstream-error-rules，
// Go 侧的承接判定在 application/upstreamrules。任何无法忠实表达的账号一律跳过，
// 而不是让 Go 用残缺规则集做出不同结论。

const {
  readUpstreamErrorGroupIds,
  readUpstreamErrorRules
} = require('../account/upstream-error-rules');

const RULE_KINDS = new Set([
  'billing_blocked', 'quota_exhausted', 'auth_invalid',
  'permission_denied', 'rate_limited', 'service_unavailable'
]);
const LEGACY_FIELDS = new Set(['code', 'type', 'message', 'body']);
const SOURCES = new Set(['http_code', 'body', 'json']);
const OPERATORS = new Set(['regex', 'contains', 'equals']);

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

/**
 * 收集「账号级配置」记录：账号自身规则 + 挂载组 id 顺序。
 *
 * 这里不拼装、不合并组规则：有效规则由 Go 读取映射组表后计算，
 * Node 只负责把账号自己的配置推过去。
 * 规则顺序与组顺序（AIH_UPSTREAM_ERROR_GROUP_IDS 的数组顺序）都原样保留。
 *
 * 忠实性优先：一条无法投影的规则会让整个账号跳过，而不是让 Go 用残缺
 * 规则集得出不同结论。
 */
function collectAccountUpstreamErrorRuleRecords(accounts, options = {}) {
  const records = [];
  const skipped = [];
  const seenGoRefs = new Set();
  const source = Array.isArray(accounts) ? [...accounts] : [];
  source.sort((left, right) => String(left && left.accountRef || '').localeCompare(String(right && right.accountRef || '')));
  for (const account of source) {
    const accountRef = String(account && account.accountRef || '').trim();
    if (!accountRef) continue;
    const provider = String(account && account.provider || '').trim().toLowerCase();
    const env = account && account.env && typeof account.env === 'object' ? account.env : {};
    const direct = readUpstreamErrorRules(env);
    const groupIds = readUpstreamErrorGroupIds(env);
    // 没有账号级数据（既无自身规则也无组挂载）的账号不需要在 Go 里占一条记录。
    if (!direct.length && !groupIds.length) continue;
    if (!provider) {
      skipped.push({ accountRef, reason: 'provider_missing' });
      continue;
    }
    const projected = [];
    let faithful = true;
    for (const rule of direct) {
      const item = projectRule(rule);
      if (!item) {
        faithful = false;
        break;
      }
      projected.push(item);
    }
    if (!faithful) {
      skipped.push({ accountRef, reason: 'unprojectable_rule' });
      continue;
    }
    const goRef = resolveGoRef(accountRef, options.goRefFor);
    if (!goRef) {
      skipped.push({ accountRef, reason: 'unresolved_go_ref' });
      continue;
    }
    // 身份合并后两个 Node 引用可能指向同一个 Go 账号：只保留一份，避免后写覆盖。
    if (seenGoRefs.has(goRef)) continue;
    seenGoRefs.add(goRef);
    records.push({
      account_ref: goRef,
      provider,
      group_ids: groupIds,
      rules: projected
    });
  }
  return { records, skipped };
}

module.exports = {
  collectAccountUpstreamErrorRuleRecords
};
