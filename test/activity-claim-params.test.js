'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { validateProviderDescriptor } = require('../lib/providers/contract');
const {
  normalizeActivityParams,
  resolveActivityTargets,
  describeActivityParams
} = require('../lib/account/activity-claim/params');
const { classifyPlan, describePlanKinds } = require('../lib/account/activity-claim/plans');
const { stableFingerprint } = require('../lib/server/stable-fingerprint');
const { runKey } = require('../lib/server/scheduled-run-guard');

function descriptorWithActivity(activity) {
  return {
    contractVersion: 1,
    id: 'broken',
    capabilities: { quota: { supported: false, reason: 'none' }, activity }
  };
}

function baseAction(overrides = {}) {
  return {
    id: 'trial_plan',
    label: '领臭鸡蛋',
    handler: 'zcode-plan-claim',
    ...overrides
  };
}

const ACCOUNT_PARAM = {
  key: 'accountRefs', label: '账号', type: 'account-refs', emptyMeans: 'all', maxItems: 2
};
const KINDS = [
  { id: 'weekend_build', label: 'WEEKEND', when: { planIdSuffix: '-wk' } },
  { id: 'start_plan', label: 'START', when: { planIdPrefix: 'zcode-v3-start-plan' } }
];
const KIND_PARAM = { key: 'planKind', label: '类型', type: 'enum', optionsFrom: 'kinds' };

test('契约：坏声明当场拒绝，未知字段不再静默丢弃', () => {
  const bad = (activity) => () => validateProviderDescriptor(descriptorWithActivity(activity));

  assert.throws(bad({ supported: true, actions: [] }), /provider_descriptor_activity_actions_empty/);
  assert.throws(
    bad({ supported: true, actions: [baseAction({ params: [ACCOUNT_PARAM], typo: 1 })] }),
    /provider_descriptor_activity_action_field_unknown/
  );
  assert.throws(
    bad({ supported: true, actions: [baseAction({ params: [{ key: 'a', label: 'A', type: 'nope' }] })] }),
    /provider_descriptor_activity_param_type_unknown/
  );
  assert.throws(
    bad({ supported: true, actions: [baseAction({ params: [KIND_PARAM] })] }),
    /provider_descriptor_activity_kind_ref_missing/
  );
  assert.throws(
    bad({ supported: true, actions: [baseAction({ kinds: [KINDS[0], { ...KINDS[0] }] })] }),
    /provider_descriptor_activity_kind_duplicate/
  );
  assert.throws(
    bad({ supported: true, actions: [baseAction({ kinds: [{ id: 'x', label: 'X', when: { unknownPredicate: 'v' } }] })] }),
    /provider_descriptor_activity_kind_predicate_unknown/
  );
  assert.throws(
    bad({ supported: true, actions: [baseAction({ params: [{ key: 'e', label: 'E', type: 'enum' }] })] }),
    /provider_descriptor_activity_param_options_invalid/
  );
});

test('契约：合法声明被冻结透传（params / kinds / supportsProbe 都读得到）', () => {
  const descriptor = validateProviderDescriptor(descriptorWithActivity({
    supported: true,
    actions: [baseAction({ supportsProbe: true, params: [ACCOUNT_PARAM, KIND_PARAM], kinds: KINDS })]
  }));
  const action = descriptor.capabilities.activity.actions[0];
  assert.equal(action.supportsProbe, true);
  assert.equal(action.params.length, 2);
  assert.equal(action.params[1].optionsFrom, 'kinds');
  assert.equal(action.kinds[0].id, 'weekend_build');
  assert.equal(describeActivityParams(action)[0].maxItems, 2);
});

const ACTION = {
  params: [ACCOUNT_PARAM, KIND_PARAM],
  kinds: KINDS
};

test('参数归一：空值不进 params，账号去重排序，枚举越界拒绝', () => {
  assert.deepEqual(normalizeActivityParams(ACTION, {}), { ok: true, params: {} });
  assert.deepEqual(normalizeActivityParams(ACTION, { accountRefs: [] }), { ok: true, params: {} });
  assert.deepEqual(
    normalizeActivityParams(ACTION, { accountRefs: ['b', 'a', 'b'], planKind: 'weekend_build' }),
    { ok: true, params: { accountRefs: ['a', 'b'], planKind: 'weekend_build' } }
  );
  assert.deepEqual(
    normalizeActivityParams(ACTION, { accountRefs: ['a', 'b', 'c'] }),
    { ok: false, error: 'activity_param_too_many:accountRefs' }
  );
  assert.deepEqual(
    normalizeActivityParams(ACTION, { planKind: 'nope' }),
    { ok: false, error: 'activity_param_value_invalid:planKind' }
  );
  // 未知 key 丢弃（schema 才是唯一真相）
  assert.deepEqual(normalizeActivityParams(ACTION, { whatever: 1 }), { ok: true, params: {} });
});

test('目标解析：空账号参数 = 全部账号，指定账号 = 子集，未知账号单独报出来', () => {
  const targets = [
    { provider: 'zcode', record: { accountRef: 'a' } },
    { provider: 'zcode', record: { accountRef: 'b' } }
  ];
  assert.deepEqual(resolveActivityTargets(ACTION, {}, targets), {
    targets,
    unknownAccountRefs: []
  });

  const subset = resolveActivityTargets(ACTION, { accountRefs: ['b'] }, targets);
  assert.deepEqual(subset.targets.map((item) => item.record.accountRef), ['b']);
  assert.deepEqual(subset.unknownAccountRefs, []);

  const missing = resolveActivityTargets(ACTION, { accountRefs: ['a', 'ghost'] }, targets);
  assert.deepEqual(missing.targets.map((item) => item.record.accountRef), ['a']);
  assert.deepEqual(missing.unknownAccountRefs, ['ghost']);
});

test('分类：先按 plan_id 判（投放通道只有 plan_id），name 只作辅助', () => {
  assert.equal(classifyPlan({ planId: 'zcode-v3-start-plan-1030-wk' }, KINDS), 'weekend_build');
  assert.equal(classifyPlan({ planId: 'zcode-v3-start-plan-0817' }, KINDS), 'start_plan');
  // 投放通道没有 name，也必须能分类
  assert.equal(classifyPlan({ planId: 'zcode-v3-start-plan-1030-wk', name: '' }, KINDS), 'weekend_build');
  assert.equal(classifyPlan({ planId: 'something-else' }, KINDS), '');

  const kinds = describePlanKinds(KINDS, [
    { planId: 'zcode-v3-start-plan-1030-wk' },
    { planId: 'zcode-v3-start-plan-0817' }
  ]);
  assert.deepEqual(kinds.map((kind) => [kind.id, kind.claimable]), [
    ['weekend_build', true],
    ['start_plan', true]
  ]);
});

test('指纹与运行键：顺序无关、空参数保持裸 id', () => {
  assert.equal(stableFingerprint({}), '');
  assert.equal(stableFingerprint(undefined), '');
  assert.equal(
    stableFingerprint({ accountRefs: ['a', 'b'], planKind: 'weekend_build' }),
    stableFingerprint({ planKind: 'weekend_build', accountRefs: ['b', 'a'] })
  );
  assert.notEqual(
    stableFingerprint({ planKind: 'weekend_build' }),
    stableFingerprint({ planKind: 'start_plan' })
  );

  // 老任务（无参数）的键必须与历史完全一致
  assert.equal(runKey('activity:zcode:trial_plan'), 'activity:zcode:trial_plan');
  assert.equal(runKey('activity:zcode:trial_plan', {}), 'activity:zcode:trial_plan');
  assert.match(
    runKey('activity:zcode:trial_plan', { planKind: 'weekend_build' }),
    /^activity:zcode:trial_plan#\{/
  );
});
