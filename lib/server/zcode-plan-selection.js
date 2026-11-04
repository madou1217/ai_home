'use strict';

// zcode 多套餐账号的「用哪个套餐」决策（唯一实现处）。
//
// 一个账号可以叠加多个套餐（基础套餐 + 「领臭鸡蛋」拿到的试用套餐），每个套餐
// 有独立的额度池与到期时间。用户明确要求：**先烧最快过期的那一个**，用完再切
// 下一个——明早过期的先用，后天的留到后面。
//
// 数据来源是额度快照的 planGroups（见 zcode-quota-probe.buildZcodePlanGroups）：
//   { planGroupId, planId, name, status, endsAtMs, effectiveAtMs, priority, entries[] }
// 其中 entries[].remainingPct 是上游给的剩余比例（null = 未提供，按未知处理）。
//
// 判定顺序（与用户语义一一对应）：
//   1. 未生效（effectiveAtMs > now）→ 不可用；
//   2. 已过期（endsAtMs > 0 且 <= now）→ 不可用；
//   3. 额度已耗尽（所有 entry 的 remainingPct 都是 0）→ 不可用；
//   4. 其余按 endsAtMs 升序；没有到期时间（0）视为最晚；同刻按 priority 降序。
//
// 「用完自动切换」有两层：
//   * 快照层：remainingPct 归零后下一次构池自然跳过它（本模块的可用性判定）；
//   * 运行期：上游回额度耗尽时由 applyPlanExhaustion 打短期标记并换套餐，
//     同请求内即可用下一个套餐重试（见 upstream-endpoints-transport-general）。

const { resolveZcodeInferenceBaseUrl } = require('../account/provider-api-base-url');

const DEFAULT_EXHAUSTION_TTL_MS = 30 * 60 * 1000;
const NEVER = Number.POSITIVE_INFINITY;

// 运行期「这个套餐刚被上游判额度耗尽」的短期标记：accountRef:planId → 到期时间。
const exhaustedPlans = new Map();

function normalizeText(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function exhaustionKey(accountRef, planId) {
  return `${normalizeText(accountRef)}:${normalizeText(planId)}`;
}

function markPlanExhausted(accountRef, planId, options = {}) {
  const key = exhaustionKey(accountRef, planId);
  if (!normalizeText(accountRef) || !normalizeText(planId)) return;
  const nowMs = Number(options.nowMs) || Date.now();
  const ttlMs = Math.max(1_000, Number(options.ttlMs) || DEFAULT_EXHAUSTION_TTL_MS);
  exhaustedPlans.set(key, nowMs + ttlMs);
}

function isPlanMarkedExhausted(accountRef, planId, options = {}) {
  const key = exhaustionKey(accountRef, planId);
  const untilMs = Number(exhaustedPlans.get(key)) || 0;
  if (!untilMs) return false;
  const nowMs = Number(options.nowMs) || Date.now();
  if (untilMs <= nowMs) {
    exhaustedPlans.delete(key);
    return false;
  }
  return true;
}

function clearPlanExhaustion(accountRef) {
  const prefix = `${normalizeText(accountRef)}:`;
  for (const key of exhaustedPlans.keys()) {
    if (key.startsWith(prefix)) exhaustedPlans.delete(key);
  }
}

function readPlanGroups(snapshot) {
  const groups = snapshot && Array.isArray(snapshot.planGroups) ? snapshot.planGroups : [];
  return groups.filter((group) => group && typeof group === 'object' && normalizeText(group.planId));
}

function entryRemainingPct(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const raw = entry.remainingPct;
  // Number(null) === 0：上游没给剩余比例时绝不能当成「已耗尽」，
  // 否则一次探测缺字段就会把还有额度的套餐从候选里剔除。
  if (raw === null || raw === undefined || raw === '') return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, value));
}

// 套餐整体剩余：取所有额度桶里最小的那个（任一桶见底就代表这个套餐见底）。
function planRemainingPct(group) {
  const entries = Array.isArray(group && group.entries) ? group.entries : [];
  let min = null;
  for (const entry of entries) {
    const pct = entryRemainingPct(entry);
    if (pct === null) continue;
    if (min === null || pct < min) min = pct;
  }
  return min;
}

function planEndsAtMs(group) {
  const value = Number(group && group.endsAtMs);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function planEffectiveAtMs(group) {
  const value = Number(group && group.effectiveAtMs);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function isPlanUsable(group, options = {}) {
  const nowMs = Number(options.nowMs) || Date.now();
  const effectiveAtMs = planEffectiveAtMs(group);
  if (effectiveAtMs > 0 && effectiveAtMs > nowMs) return false;
  const endsAtMs = planEndsAtMs(group);
  if (endsAtMs > 0 && endsAtMs <= nowMs) return false;
  // 只有「有额度桶且全部见底」才算耗尽；空 entries 是「额度未知」，不能据此排除。
  if (planRemainingPct(group) === 0) return false;
  if (options.accountRef && isPlanMarkedExhausted(options.accountRef, group.planId, options)) return false;
  return true;
}

function comparePlansByExpiry(left, right) {
  const leftEnds = planEndsAtMs(left) || NEVER;
  const rightEnds = planEndsAtMs(right) || NEVER;
  if (leftEnds !== rightEnds) return leftEnds - rightEnds;
  const leftPriority = Number(left && left.priority) || 0;
  const rightPriority = Number(right && right.priority) || 0;
  if (leftPriority !== rightPriority) return rightPriority - leftPriority;
  return normalizeText(left && left.planId).localeCompare(normalizeText(right && right.planId));
}

/** 可用套餐，按「最快过期优先」排序。 */
function orderUsablePlans(snapshot, options = {}) {
  return readPlanGroups(snapshot)
    .filter((group) => isPlanUsable(group, options))
    .sort(comparePlansByExpiry);
}

/**
 * 当前应该用哪个套餐。返回 `{ planId, group }` 或 null。
 * 没有 planGroups 的快照（老数据 / 探测失败）返回 null，调用方沿用旧兜底。
 */
function selectPlanForUse(snapshot, options = {}) {
  const [first] = orderUsablePlans(snapshot, options);
  return first ? { planId: normalizeText(first.planId), group: first } : null;
}

/**
 * 把账号的 planIds 重排成「选中套餐在最前，其余可用套餐按过期时间跟上」。
 * 保留快照里没覆盖到的 id（追加在尾部），避免丢信息。
 */
function orderPlanIdsForUse(planIds, snapshot, options = {}) {
  const input = Array.isArray(planIds) ? planIds.map(normalizeText).filter(Boolean) : [];
  const usable = orderUsablePlans(snapshot, options).map((group) => normalizeText(group.planId));
  const ordered = [];
  for (const planId of [...usable, ...input]) {
    if (!planId || ordered.includes(planId)) continue;
    ordered.push(planId);
  }
  return ordered;
}

function currentPlanIdOf(account) {
  const activePlanId = normalizeText(account && account.activePlanId);
  if (activePlanId) return activePlanId;
  const planIds = Array.isArray(account && account.planIds) ? account.planIds : [];
  return normalizeText(planIds[0]);
}

/**
 * 运行期换套餐：把账号切到下一个可用套餐（跳过当前与已标记耗尽的）。
 * 直接改 account 上的三个字段——端点、鉴权形态、验证参数都从它们派生，
 * 三个必须同时更新，否则会出现「新端点 + 旧鉴权形态」的自相矛盾请求。
 *
 * @returns {{ rotated: boolean, planId?: string, reason?: string }}
 */
function rotatePlanForAccount(account, options = {}) {
  if (!account || typeof account !== 'object') return { rotated: false, reason: 'no_account' };
  const snapshot = account.usageSnapshot || null;
  if (!readPlanGroups(snapshot).length) return { rotated: false, reason: 'no_plan_groups' };
  const currentPlanId = currentPlanIdOf(account);
  const candidates = orderUsablePlans(snapshot, {
    ...options,
    accountRef: account.accountRef
  }).filter((group) => normalizeText(group.planId) !== currentPlanId);
  if (candidates.length === 0) return { rotated: false, reason: 'no_other_plan' };
  const nextPlanId = normalizeText(candidates[0].planId);
  account.activePlanId = nextPlanId;
  account.planIds = orderPlanIdsForUse(account.planIds, snapshot, {
    ...options,
    accountRef: account.accountRef
  });
  account.openaiBaseUrl = resolveZcodeInferenceBaseUrl(nextPlanId, account.zcodeRegion);
  return { rotated: true, planId: nextPlanId, previousPlanId: currentPlanId };
}

/**
 * 上游判「当前套餐额度用尽」时的统一动作：先标记这个套餐，再换到下一个可用套餐。
 * 标记是必要的——快照里的 remainingPct 要等下一次额度扫描才归零，这中间
 * 不标记就会一直选中同一个已经死掉的套餐。
 */
function applyPlanExhaustion(account, options = {}) {
  if (!account || typeof account !== 'object') return { rotated: false, reason: 'no_account' };
  const exhaustedPlanId = currentPlanIdOf(account);
  if (exhaustedPlanId) markPlanExhausted(account.accountRef, exhaustedPlanId, options);
  return { ...rotatePlanForAccount(account, options), exhaustedPlanId };
}

/** 该失败策略是否表示「当前套餐额度用尽」。只认 zcode，且只认额度类结论。 */
function isPlanExhaustionPolicy(policy, provider) {
  if (normalizeText(provider).toLowerCase() !== 'zcode') return false;
  if (!policy || typeof policy !== 'object') return false;
  return policy.kind === 'account_no_resource_package'
    || policy.kind === 'model_quota_exhausted'
    || policy.failureReason === 'zcode_no_resource_package';
}

module.exports = {
  DEFAULT_EXHAUSTION_TTL_MS,
  applyPlanExhaustion,
  clearPlanExhaustion,
  isPlanExhaustionPolicy,
  isPlanMarkedExhausted,
  isPlanUsable,
  markPlanExhausted,
  orderPlanIdsForUse,
  orderUsablePlans,
  planRemainingPct,
  rotatePlanForAccount,
  selectPlanForUse,
  __private: {
    comparePlansByExpiry,
    exhaustedPlans,
    planEndsAtMs
  }
};
