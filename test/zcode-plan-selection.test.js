'use strict';

// 回归守卫（用户目标，2026-11-05）：一个账号叠加多个套餐时，**先烧最快过期的那一个**，
// 用完自动切到下一个。
//   * 明早过期 vs 后天过期 → 明早的优先；
//   * 未生效 / 已过期 / 额度归零 / 本次请求内刚被判耗尽的套餐 → 跳过；
//   * 上游回额度耗尽时换的是**套餐**，不是把整个账号冷却掉。
// 数据形状来自 zcode-quota-probe.buildZcodePlanGroups。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  applyPlanExhaustion,
  clearPlanExhaustion,
  isPlanExhaustionPolicy,
  isPlanMarkedExhausted,
  isPlanUsable,
  markPlanExhausted,
  orderPlanIdsForUse,
  orderUsablePlans,
  rotatePlanForAccount,
  selectPlanForUse
} = require('../lib/server/zcode-plan-selection');
const { isJwtPlanAccount } = require('../lib/server/relay-auth-plan-kind');
const {
  __private: { rotateZcodePlanForExhaustion }
} = require('../lib/server/upstream-endpoints-transport-general');
const {
  ZCODE_PLAN_JWT_ANTHROPIC_BASE_URL,
  ZCODE_ULTRA_ANTHROPIC_BASE_URL,
  ZCODE_ULTRA_ZAI_ANTHROPIC_BASE_URL
} = require('../lib/account/provider-api-base-url');

// 相对当前时刻构造「明早过期 / 后天过期」，避免用例依赖真实日历。
const NOW = Date.now();
const HOUR = 60 * 60 * 1000;

const START_PLAN = 'zcode-v3-start-plan-1104';
const CODING_PLAN = 'zcode-v3-individual-coding-plan-0817';

function planGroup({
  planId,
  endsAtMs = 0,
  effectiveAtMs = 0,
  remainingPct = 100,
  priority = 0,
  entries
} = {}) {
  return {
    planGroupId: `group-${planId}`,
    planId,
    name: planId,
    status: 'active',
    endsAtMs,
    effectiveAtMs,
    priority,
    entries: Array.isArray(entries)
      ? entries
      : [{ remainingPct }]
  };
}

function snapshot(groups, planIds = groups.map((group) => group.planId)) {
  return {
    kind: 'zcode_plan_balance',
    source: 'zcode',
    capturedAt: NOW,
    entries: [],
    planGroups: groups,
    account: { planIds }
  };
}

function account(overrides = {}) {
  return {
    accountRef: 'acct_plan_selection_test',
    provider: 'zcode',
    zcodeRegion: 'bigmodel',
    activePlanId: START_PLAN,
    planIds: [START_PLAN, CODING_PLAN],
    openaiBaseUrl: ZCODE_PLAN_JWT_ANTHROPIC_BASE_URL,
    usageSnapshot: snapshot([
      planGroup({ planId: START_PLAN, endsAtMs: NOW + 19 * HOUR }),
      planGroup({ planId: CODING_PLAN, endsAtMs: NOW + 72 * HOUR })
    ]),
    ...overrides
  };
}

test.afterEach(() => {
  clearPlanExhaustion('acct_plan_selection_test');
});

test('先烧最快过期的套餐（与数组顺序、priority 无关）', () => {
  const nearExpiry = planGroup({ planId: START_PLAN, endsAtMs: NOW + 19 * HOUR, priority: 1 });
  const later = planGroup({ planId: CODING_PLAN, endsAtMs: NOW + 72 * HOUR, priority: 999 });
  const ordered = orderUsablePlans(snapshot([later, nearExpiry]), { nowMs: NOW });
  assert.deepEqual(ordered.map((group) => group.planId), [START_PLAN, CODING_PLAN]);
  assert.equal(selectPlanForUse(snapshot([later, nearExpiry]), { nowMs: NOW }).planId, START_PLAN);
});

test('没有到期时间的套餐排在最后（不能抢占快过期的）', () => {
  const noExpiry = planGroup({ planId: CODING_PLAN, endsAtMs: 0 });
  const nearExpiry = planGroup({ planId: START_PLAN, endsAtMs: NOW + HOUR });
  const ordered = orderUsablePlans(snapshot([noExpiry, nearExpiry]), { nowMs: NOW });
  assert.deepEqual(ordered.map((group) => group.planId), [START_PLAN, CODING_PLAN]);
});

test('未生效 / 已过期 / 额度归零的套餐不参与选择', () => {
  const pending = planGroup({ planId: 'zcode-v3-start-plan-pending', effectiveAtMs: NOW + HOUR });
  const expired = planGroup({ planId: 'zcode-v3-start-plan-expired', endsAtMs: NOW - HOUR });
  const empty = planGroup({ planId: 'zcode-v3-start-plan-empty', remainingPct: 0 });
  const usable = planGroup({ planId: START_PLAN, endsAtMs: NOW + 19 * HOUR });
  const snap = snapshot([pending, expired, empty, usable]);

  assert.equal(isPlanUsable(pending, { nowMs: NOW }), false);
  assert.equal(isPlanUsable(expired, { nowMs: NOW }), false);
  assert.equal(isPlanUsable(empty, { nowMs: NOW }), false);
  assert.equal(isPlanUsable(usable, { nowMs: NOW }), true);
  assert.deepEqual(orderUsablePlans(snap, { nowMs: NOW }).map((group) => group.planId), [START_PLAN]);
});

test('额度未知（entries 为空 / remainingPct=null）按可用处理，不误杀', () => {
  const unknown = planGroup({ planId: START_PLAN, endsAtMs: NOW + HOUR, entries: [] });
  const noPct = planGroup({ planId: CODING_PLAN, endsAtMs: NOW + 2 * HOUR, entries: [{ remainingPct: null }] });
  const snap = snapshot([unknown, noPct]);
  assert.equal(isPlanUsable(unknown, { nowMs: NOW }), true);
  assert.equal(isPlanUsable(noPct, { nowMs: NOW }), true);
  assert.equal(selectPlanForUse(snap, { nowMs: NOW }).planId, START_PLAN);
});

test('planIds 重排：选中套餐在最前，快照没覆盖到的 id 保留在尾部', () => {
  const snap = snapshot([
    planGroup({ planId: CODING_PLAN, endsAtMs: NOW + 72 * HOUR }),
    planGroup({ planId: START_PLAN, endsAtMs: NOW + 19 * HOUR })
  ], [CODING_PLAN, 'legacy-plan-id', START_PLAN]);
  assert.deepEqual(
    orderPlanIdsForUse([CODING_PLAN, 'legacy-plan-id', START_PLAN], snap, { nowMs: NOW }),
    [START_PLAN, CODING_PLAN, 'legacy-plan-id']
  );
});

test('rotatePlanForAccount 同时更新端点、activePlanId、planIds（三者不可分叉）', () => {
  const target = account();
  // 当前套餐被判耗尽后，换到 coding-plan。
  markPlanExhausted(target.accountRef, START_PLAN, { nowMs: NOW });
  const rotation = rotatePlanForAccount(target, { nowMs: NOW });

  assert.equal(rotation.rotated, true);
  assert.equal(rotation.planId, CODING_PLAN);
  assert.equal(rotation.previousPlanId, START_PLAN);
  assert.equal(target.activePlanId, CODING_PLAN);
  assert.deepEqual(target.planIds, [CODING_PLAN, START_PLAN]);
  // bigmodel 区的 coding plan 走 ultra 端点，而不是 start-plan 的 jwt 端点。
  assert.equal(target.openaiBaseUrl, ZCODE_ULTRA_ANTHROPIC_BASE_URL);
});

test('rotatePlanForAccount 按区域选 ultra 端点（zai → ultra-zai）', () => {
  const target = account({ zcodeRegion: 'zai' });
  markPlanExhausted(target.accountRef, START_PLAN, { nowMs: NOW });
  assert.equal(rotatePlanForAccount(target, { nowMs: NOW }).rotated, true);
  assert.equal(target.openaiBaseUrl, ZCODE_ULTRA_ZAI_ANTHROPIC_BASE_URL);
});

test('用完一个自动切下一个：第二次耗尽切到第三个，全部用完才放弃', () => {
  const third = 'zcode-v3-start-plan-1201';
  const target = account({
    usageSnapshot: snapshot([
      planGroup({ planId: START_PLAN, endsAtMs: NOW + 19 * HOUR }),
      planGroup({ planId: CODING_PLAN, endsAtMs: NOW + 72 * HOUR }),
      planGroup({ planId: third, endsAtMs: NOW + 120 * HOUR })
    ], [START_PLAN, CODING_PLAN, third])
  });

  const first = applyPlanExhaustion(target, { nowMs: NOW });
  assert.equal(first.rotated, true);
  assert.equal(first.planId, CODING_PLAN);
  assert.equal(isPlanMarkedExhausted(target.accountRef, START_PLAN, { nowMs: NOW }), true);

  const second = applyPlanExhaustion(target, { nowMs: NOW });
  assert.equal(second.rotated, true);
  assert.equal(second.planId, third);

  const thirdRotation = applyPlanExhaustion(target, { nowMs: NOW });
  assert.equal(thirdRotation.rotated, false);
  assert.equal(thirdRotation.reason, 'no_other_plan');
  assert.equal(target.activePlanId, third);
});

test('单套餐账号换不动时返回 no_other_plan（不伪造切换）', () => {
  const target = account({
    activePlanId: START_PLAN,
    planIds: [START_PLAN],
    usageSnapshot: snapshot([planGroup({ planId: START_PLAN, endsAtMs: NOW + 19 * HOUR })])
  });
  const rotation = applyPlanExhaustion(target, { nowMs: NOW });
  assert.equal(rotation.rotated, false);
  assert.equal(rotation.reason, 'no_other_plan');
  assert.equal(target.activePlanId, START_PLAN);
  assert.equal(target.openaiBaseUrl, ZCODE_PLAN_JWT_ANTHROPIC_BASE_URL);
});

test('isPlanExhaustionPolicy 只认 zcode 的额度类结论', () => {
  const cases = [
    [{ kind: 'account_no_resource_package' }, 'zcode', true],
    [{ kind: 'model_quota_exhausted' }, 'zcode', true],
    [{ kind: 'account_usage_exhausted', failureReason: 'zcode_no_resource_package' }, 'zcode', true],
    [{ kind: 'model_quota_exhausted' }, 'codex', false],
    [{ kind: 'rate_limited' }, 'zcode', false],
    [{ kind: 'account_no_resource_package' }, 'claude', false],
    [null, 'zcode', false]
  ];
  for (const [policy, provider, expected] of cases) {
    assert.equal(isPlanExhaustionPolicy(policy, provider), expected,
      `${provider} / ${policy && policy.kind} 应判 ${expected}`);
  }
});

test('鉴权形态按当前套餐分叉：coding-plan 生效时不能按 planIds 列表判成 jwt 直通', () => {
  const auth = {
    kind: 'business_token_pair',
    jwtPlanKinds: ['start-plan'],
    extraTokenField: 'zcodeJwtToken'
  };
  // 列表里同时有 start-plan，但当前烧的是 coding-plan → 双头（非 jwt）。
  assert.equal(isJwtPlanAccount({
    activePlanId: CODING_PLAN,
    planIds: [CODING_PLAN, START_PLAN],
    zcodeJwtToken: 'jwt'
  }, auth), false);
  // 当前烧的是 start-plan → 单头 jwt。
  assert.equal(isJwtPlanAccount({
    activePlanId: START_PLAN,
    planIds: [START_PLAN, CODING_PLAN],
    zcodeJwtToken: 'jwt'
  }, auth), true);
  // 老账号没有 activePlanId 时沿用列表判定。
  assert.equal(isJwtPlanAccount({ planIds: [START_PLAN], zcodeJwtToken: 'jwt' }, auth), true);
  assert.equal(isJwtPlanAccount({ planIds: [CODING_PLAN], zcodeJwtToken: 'jwt' }, auth), false);
});

test('验证参数按当前套餐判定：coding-plan 生效时不去解 start-plan 的验证码', () => {
  const { needsRequestVerification } = require('../lib/server/request-verification-provider');
  const auth = { requestVerification: { planKinds: ['start-plan'] } };
  assert.equal(needsRequestVerification({
    activePlanId: START_PLAN,
    planIds: [START_PLAN, CODING_PLAN]
  }, auth), true);
  assert.equal(needsRequestVerification({
    activePlanId: CODING_PLAN,
    planIds: [CODING_PLAN, START_PLAN]
  }, auth), false);
  // 老账号没有 activePlanId 时沿用列表判定。
  assert.equal(needsRequestVerification({ planIds: [START_PLAN] }, auth), true);
});

test('传输层钩子：额度耗尽时换套餐并允许同账号重试，不按账号失败处理', () => {
  const target = account();
  const retried = [];
  const extended = [];
  const logged = [];
  const attemptMutable = {};

  const rotation = rotateZcodePlanForExhaustion({
    policy: { kind: 'model_quota_exhausted', detail: 'upstream_business_1005: exceed quota limit' },
    provider: 'zcode',
    account: target,
    attemptMutable,
    logRetryFailure: (policy, data) => logged.push({ policy, data }),
    control: {
      attempt: 0,
      setLastError() {},
      retrySameAccount() { retried.push(true); },
      extendAttemptBudget(extra) { extended.push(extra); }
    }
  });

  assert.equal(rotation.rotated, true);
  assert.equal(rotation.planId, CODING_PLAN);
  assert.equal(retried.length, 1);
  // 单账号池的 maxAttempts 是 1：不追加预算就没有第二次机会。
  assert.deepEqual(extended, [1]);
  assert.equal(logged.length, 1);
  assert.equal(logged[0].data.zcodePlanRotatedTo, CODING_PLAN);
  assert.equal(attemptMutable.annotations.zcodePlanRotatedTo, CODING_PLAN);
  assert.equal(attemptMutable.annotations.zcodePlanExhausted, START_PLAN);
  assert.equal(attemptMutable.lastError, 'upstream_business_1005: exceed quota limit');
});

test('传输层钩子：流已开始的路径只切套餐，不动重试预算', () => {
  const target = account();
  let retried = 0;
  let extended = 0;
  const rotation = rotateZcodePlanForExhaustion({
    policy: { kind: 'model_quota_exhausted', detail: 'quota' },
    provider: 'zcode',
    account: target,
    attemptMutable: {},
    allowRetry: false,
    logRetryFailure() {},
    control: {
      setLastError() {},
      retrySameAccount() { retried += 1; },
      extendAttemptBudget() { extended += 1; }
    }
  });
  assert.equal(rotation.rotated, true);
  assert.equal(target.activePlanId, CODING_PLAN);
  assert.equal(retried, 0);
  assert.equal(extended, 0);
});

test('单账号池：extendAttemptBudget 让换套餐后的同账号重试真正发生', async () => {
  const { runWithAccountAttempts } = require('../lib/server/request-orchestrator');
  const pool = [{ accountRef: 'acct_only' }];
  const seen = [];
  const result = await runWithAccountAttempts({
    pool,
    maxAttempts: 1,
    provider: 'zcode',
    model: 'glm-5.3',
    chooseServerAccount: (accounts, state, cursorKey, options) => (
      accounts.find((item) => !options.excludeAccountRefs.has(item.accountRef)) || null
    ),
    onAttempt: async (account, control) => {
      seen.push(control.attempt);
      if (seen.length === 1) {
        control.retrySameAccount();
        control.extendAttemptBudget(1);
        return { action: 'retry_same' };
      }
      return { action: 'return', value: 'ok' };
    }
  });
  assert.equal(result.kind, 'returned');
  assert.deepEqual(seen, [0, 1]);
});

test('单账号池：不追加预算时 maxAttempts=1 确实只有一次机会', async () => {
  const { runWithAccountAttempts } = require('../lib/server/request-orchestrator');
  const pool = [{ accountRef: 'acct_only' }];
  let attempts = 0;
  const result = await runWithAccountAttempts({
    pool,
    maxAttempts: 1,
    provider: 'zcode',
    model: 'glm-5.3',
    chooseServerAccount: (accounts, state, cursorKey, options) => (
      accounts.find((item) => !options.excludeAccountRefs.has(item.accountRef)) || null
    ),
    onAttempt: async (account, control) => {
      attempts += 1;
      control.retrySameAccount();
      return { action: 'retry_same' };
    }
  });
  assert.equal(result.kind, 'attempts_exhausted');
  assert.equal(attempts, 1);
});

test('传输层钩子：非 zcode / 非额度结论 / 换不动时都返回 null', () => {
  const quotaPolicy = { kind: 'model_quota_exhausted', detail: 'quota' };
  const base = {
    attemptMutable: {},
    logRetryFailure() {},
    control: { setLastError() {}, retrySameAccount() { throw new Error('不应重试'); } }
  };

  assert.equal(rotateZcodePlanForExhaustion({
    ...base, policy: quotaPolicy, provider: 'codex', account: account()
  }), null);
  assert.equal(rotateZcodePlanForExhaustion({
    ...base, policy: { kind: 'rate_limited', detail: 'slow down' }, provider: 'zcode', account: account()
  }), null);

  const singlePlan = account({
    activePlanId: START_PLAN,
    planIds: [START_PLAN],
    usageSnapshot: snapshot([planGroup({ planId: START_PLAN, endsAtMs: NOW + 19 * HOUR })])
  });
  assert.equal(rotateZcodePlanForExhaustion({
    ...base, policy: quotaPolicy, provider: 'zcode', account: singlePlan
  }), null);
  assert.equal(singlePlan.activePlanId, START_PLAN);
});
