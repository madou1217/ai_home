'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ACTIVITY_OUTCOMES,
  normalizeActivityStatus,
  isActivitySuccess,
  isActivityFailure,
  normalizeActivityErrorCode,
  activityErrorCodeOf,
  summarizeActivityResults,
  formatActivitySummary,
  dominantActivityErrorCode
} = require('../lib/account/activity-claim/outcomes');

test('状态词汇表：五种正常结束 + error，未知状态 fail-closed 归为 error', () => {
  for (const status of ['claimed', 'already_claimed', 'nothing_claimable', 'not_applicable', 'dry_run', 'skipped']) {
    assert.equal(isActivitySuccess(status), true, status);
    assert.equal(isActivityFailure({ status }), false, status);
  }
  assert.equal(isActivitySuccess('error'), false);
  // handler 写错状态不能被静默算成成功
  assert.equal(normalizeActivityStatus('ok'), 'error');
  assert.equal(isActivityFailure({ status: 'ok' }), true);
  assert.equal(activityErrorCodeOf({ status: 'ok' }), 'activity_status_unknown:ok');
  assert.ok(ACTIVITY_OUTCOMES.claimed);
});

test('错误码归一：冒号后的细节不进汇总键', () => {
  assert.equal(normalizeActivityErrorCode('zcode_auth_invalid:401'), 'zcode_auth_invalid');
  assert.equal(normalizeActivityErrorCode('zcode_claim_failed:500'), 'zcode_claim_failed');
  assert.equal(normalizeActivityErrorCode('  '), '');
  assert.equal(activityErrorCodeOf({ status: 'error' }), 'activity_unknown_error');
  assert.equal(activityErrorCodeOf({ status: 'claimed' }), '');
});

test('汇总：保留历史字段，新增失败明细与按 plan 聚合', () => {
  const summary = summarizeActivityResults([
    { status: 'claimed', accountRef: 'a', plan: { planId: 'p-wk', name: 'WEEKEND', planKind: 'weekend_build' } },
    { status: 'claimed', accountRef: 'b', plan: { planId: 'p-wk', name: 'WEEKEND', planKind: 'weekend_build' } },
    { status: 'already_claimed', accountRef: 'c', claimed: [{ planId: 'p-wk', planKind: 'weekend_build' }] },
    { status: 'nothing_claimable', accountRef: 'd' },
    { status: 'error', accountRef: 'e', error: 'zcode_captcha_rejected' },
    { status: 'error', accountRef: 'f', error: 'zcode_captcha_rejected' },
    { status: 'error', accountRef: 'g', error: 'zcode_jwt_missing' }
  ]);
  assert.equal(summary.accounts, 7);
  assert.equal(summary.claimed, 2);
  assert.equal(summary.alreadyClaimed, 1);
  assert.equal(summary.nothingClaimable, 1);
  assert.equal(summary.failed, 3);
  assert.equal(summary.succeeded, 4);
  assert.equal(summary.failures.total, 3);
  assert.deepEqual(summary.failures.byCode.map((entry) => [entry.code, entry.count]), [
    ['zcode_captcha_rejected', 2],
    ['zcode_jwt_missing', 1]
  ]);
  assert.deepEqual(summary.failures.byCode[0].accountRefs, ['e', 'f']);
  assert.equal(summary.claims.length, 1);
  assert.equal(summary.claims[0].planId, 'p-wk');
  assert.equal(summary.claims[0].claimed, 2);
  assert.equal(summary.claims[0].alreadyClaimed, 1);
  assert.equal(dominantActivityErrorCode(summary), 'zcode_captcha_rejected');
});

test('摘要不再恒为 0/N：全部成功也报真实成功数', () => {
  const ok = summarizeActivityResults([{ status: 'claimed' }, { status: 'claimed' }]);
  assert.equal(formatActivitySummary(ok), '领取 2/2 成功');

  const mixed = summarizeActivityResults([
    { status: 'claimed' }, { status: 'claimed' },
    { status: 'already_claimed' }, { status: 'nothing_claimable' },
    { status: 'error', error: 'zcode_captcha_rejected' }
  ]);
  assert.equal(
    formatActivitySummary(mixed),
    '领取 4/5 成功（已领取过 1、暂无可领 1、失败 1：zcode_captcha_rejected ×1）'
  );
});

test('全部失败时给出「全部 N 个账号失败」而不是裸错误码', () => {
  const summary = summarizeActivityResults([
    { status: 'error', error: 'zcode_jwt_missing' },
    { status: 'error', error: 'zcode_jwt_missing' }
  ]);
  assert.equal(summary.errorSummary, '全部 2 个账号失败：zcode_jwt_missing ×2');
  assert.equal(summary.succeeded, 0);
});
