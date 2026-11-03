'use strict';

// 活动领取结果的**唯一词汇表**：状态分类、错误码归一、汇总与文案。
//
// 为什么要有这一层：同一个领取结果会被三处消费 —— 后台任务队列（job）、计划任务
// 运行记录、CLI 输出。三处各自写一套 `status === 'xxx'` 判断，已经出过一次真实
// 事故：`lib/server/scheduled-task-events.js` 用 `status === 'ok'` 统计成功，而活动
// 结果里根本没有 `'ok'` 这个值，于是「全部领取成功」也显示成「领取 0/N 成功」。
// 状态词汇表只有这里一份，消费方只做展示。
//
// 另一个纪律：**未知状态 fail-closed 计为失败**。handler 写错状态（或将来新增状态
// 忘了登记）时，宁可让任务变红被发现，也不能被静默算成成功。

/** 活动结果状态 → 语义。`success` 决定它是否算「正常结束」。 */
const ACTIVITY_OUTCOMES = Object.freeze({
  claimed: Object.freeze({ success: true, label: '已领取' }),
  already_claimed: Object.freeze({ success: true, label: '已领取过' }),
  nothing_claimable: Object.freeze({ success: true, label: '暂无可领' }),
  not_applicable: Object.freeze({ success: true, label: '不适用' }),
  dry_run: Object.freeze({ success: true, label: '仅探测' }),
  skipped: Object.freeze({ success: true, label: '已跳过' }),
  error: Object.freeze({ success: false, label: '失败' })
});

const UNKNOWN_STATUS_CODE = 'activity_status_unknown';
const UNKNOWN_ERROR_CODE = 'activity_unknown_error';

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** 归一状态：未知值一律落到 `error`（并由 errorCode 说明原因）。 */
function normalizeActivityStatus(status) {
  const raw = normalizeText(status).toLowerCase();
  if (Object.prototype.hasOwnProperty.call(ACTIVITY_OUTCOMES, raw)) return raw;
  return 'error';
}

function isActivitySuccess(status) {
  const normalized = normalizeActivityStatus(status);
  return ACTIVITY_OUTCOMES[normalized].success === true;
}

/**
 * 错误码归一：`zcode_auth_invalid:401` → `zcode_auth_invalid`。
 * 冒号后的部分是细节（HTTP 状态 / 异常文案），不进汇总键，否则每个账号一个桶。
 */
function normalizeActivityErrorCode(error) {
  const raw = normalizeText(error);
  if (!raw) return '';
  const head = raw.split(':')[0].trim();
  return head || UNKNOWN_ERROR_CODE;
}

/** 单个结果的有效错误码：未知状态优先报「状态不认识」，其次才是原始 error。 */
function activityErrorCodeOf(result) {
  const row = result && typeof result === 'object' ? result : {};
  const status = normalizeText(row.status).toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(ACTIVITY_OUTCOMES, status)) {
    return `${UNKNOWN_STATUS_CODE}:${status || 'empty'}`;
  }
  if (isActivitySuccess(status)) return '';
  return normalizeActivityErrorCode(row.error) || UNKNOWN_ERROR_CODE;
}

/** 一个结果是否计入失败（未知状态 fail-closed）。 */
function isActivityFailure(result) {
  const status = normalizeText(result && result.status).toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(ACTIVITY_OUTCOMES, status)) return true;
  return ACTIVITY_OUTCOMES[status].success !== true;
}

function readPlanOf(result) {
  const row = result && typeof result === 'object' ? result : {};
  const plan = row.plan && typeof row.plan === 'object'
    ? row.plan
    : (Array.isArray(row.claimed) && row.claimed[0] && typeof row.claimed[0] === 'object' ? row.claimed[0] : null);
  if (!plan) return null;
  const planId = normalizeText(plan.planId);
  if (!planId) return null;
  return {
    planId,
    name: normalizeText(plan.name),
    planKind: normalizeText(plan.planKind || row.planKind)
  };
}

/**
 * 汇总结果。保留历史字段（`accounts/claimed/alreadyClaimed/nothingClaimable/
 * notApplicable/failed`）以兼容既有 UI，新增字段只做增量。
 */
function summarizeActivityResults(results) {
  const list = Array.isArray(results) ? results : [];
  const summary = {
    accounts: list.length,
    claimed: 0,
    alreadyClaimed: 0,
    nothingClaimable: 0,
    notApplicable: 0,
    failed: 0,
    // 新增：成功总数（含「已领取过/暂无可领/不适用」这些正常结束）
    succeeded: 0,
    skipped: 0,
    byStatus: {},
    failures: { total: 0, byCode: [], byAccount: [] },
    claims: [],
    errorSummary: ''
  };
  const byCode = new Map();
  const claimsByPlan = new Map();

  for (const result of list) {
    const row = result && typeof result === 'object' ? result : {};
    const status = normalizeText(row.status).toLowerCase();
    const bucket = Object.prototype.hasOwnProperty.call(ACTIVITY_OUTCOMES, status) ? status : 'error';
    summary.byStatus[bucket] = (summary.byStatus[bucket] || 0) + 1;

    if (bucket === 'claimed') summary.claimed += 1;
    else if (bucket === 'already_claimed') summary.alreadyClaimed += 1;
    else if (bucket === 'nothing_claimable') summary.nothingClaimable += 1;
    else if (bucket === 'not_applicable') summary.notApplicable += 1;
    else if (bucket === 'skipped') summary.skipped += 1;

    if (isActivityFailure(row)) {
      summary.failed += 1;
      const code = activityErrorCodeOf(row);
      summary.failures.total += 1;
      summary.failures.byAccount.push({
        provider: normalizeText(row.provider),
        accountRef: normalizeText(row.accountRef),
        code,
        message: normalizeText(row.message)
      });
      const entry = byCode.get(code) || { code, count: 0, accountRefs: [] };
      entry.count += 1;
      const accountRef = normalizeText(row.accountRef);
      if (accountRef && !entry.accountRefs.includes(accountRef)) entry.accountRefs.push(accountRef);
      byCode.set(code, entry);
    } else {
      summary.succeeded += 1;
    }

    const plan = readPlanOf(row);
    if (plan) {
      const key = `${plan.planId}|${plan.planKind}`;
      const entry = claimsByPlan.get(key) || { ...plan, claimed: 0, alreadyClaimed: 0 };
      if (bucket === 'claimed') entry.claimed += 1;
      else if (bucket === 'already_claimed') entry.alreadyClaimed += 1;
      claimsByPlan.set(key, entry);
    }
  }

  summary.failures.byCode = [...byCode.values()]
    .sort((left, right) => right.count - left.count || left.code.localeCompare(right.code));
  summary.claims = [...claimsByPlan.values()]
    .sort((left, right) => left.planId.localeCompare(right.planId));
  summary.errorSummary = formatActivityErrorSummary(summary);
  return summary;
}

/** 失败部分的紧凑文案：`zcode_captcha_rejected ×2、zcode_jwt_missing ×1`。 */
function formatFailureCodes(failures) {
  const list = failures && Array.isArray(failures.byCode) ? failures.byCode : [];
  if (list.length === 0) return '';
  return list.slice(0, 4).map((entry) => `${entry.code} ×${entry.count}`).join('、');
}

function formatActivityErrorSummary(summary) {
  const failed = Number(summary && summary.failed) || 0;
  if (failed <= 0) return '';
  const accounts = Number(summary && summary.accounts) || 0;
  const codes = formatFailureCodes(summary && summary.failures);
  const head = failed >= accounts && accounts > 0
    ? `全部 ${accounts} 个账号失败`
    : `失败 ${failed} 个账号`;
  return codes ? `${head}：${codes}` : head;
}

/**
 * 人话摘要：`领取 2/5 成功（已领取过 1、暂无可领 1、失败 1：zcode_captcha_rejected ×1）`。
 * 「成功」= 正常结束（领到 / 已领过 / 暂无可领 / 不适用 / 跳过）。
 */
function formatActivitySummary(summary) {
  const value = summary && typeof summary === 'object' ? summary : {};
  const accounts = Number(value.accounts) || 0;
  const succeeded = Number(value.succeeded) || 0;
  const parts = [];
  if (Number(value.alreadyClaimed) > 0) parts.push(`已领取过 ${Number(value.alreadyClaimed)}`);
  if (Number(value.nothingClaimable) > 0) parts.push(`暂无可领 ${Number(value.nothingClaimable)}`);
  if (Number(value.notApplicable) > 0) parts.push(`不适用 ${Number(value.notApplicable)}`);
  if (Number(value.skipped) > 0) parts.push(`跳过 ${Number(value.skipped)}`);
  if (Number(value.failed) > 0) {
    const codes = formatFailureCodes(value.failures);
    parts.push(codes ? `失败 ${Number(value.failed)}：${codes}` : `失败 ${Number(value.failed)}`);
  }
  const head = `领取 ${succeeded}/${accounts} 成功`;
  return parts.length > 0 ? `${head}（${parts.join('、')}）` : head;
}

/** 众数错误码：`all_accounts_failed` 旁边那个「到底为什么」的机器码。 */
function dominantActivityErrorCode(summary) {
  const list = summary && summary.failures && Array.isArray(summary.failures.byCode)
    ? summary.failures.byCode
    : [];
  return list.length > 0 ? list[0].code : '';
}

module.exports = {
  ACTIVITY_OUTCOMES,
  UNKNOWN_STATUS_CODE,
  UNKNOWN_ERROR_CODE,
  normalizeActivityStatus,
  isActivitySuccess,
  isActivityFailure,
  normalizeActivityErrorCode,
  activityErrorCodeOf,
  summarizeActivityResults,
  formatActivityErrorSummary,
  formatActivitySummary,
  dominantActivityErrorCode
};
