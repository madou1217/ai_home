'use strict';

// Claude 额度形状推导：模型族不枚举、套餐不枚举。
// 这两条规则与 Go internal/adapters/claude/usage 同口径，锁住它们是为了
// 上游新增模型族/档位（fable 等）时两侧都能零改动识别。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  listModelFamilyBuckets,
  claudePlanType
} = require('../lib/cli/services/usage/claude-quota-shape');

test('every seven_day_<family> key is a model family bucket', () => {
  const buckets = listModelFamilyBuckets({
    five_hour: { utilization: 10 },
    seven_day: { utilization: 20 },
    seven_day_oauth_apps: { utilization: 30 },
    seven_day_opus: { utilization: 40, resets_at: '2026-11-12T00:00:00Z' },
    seven_day_fable: { utilization: 60, resets_at: '2026-11-12T00:00:00Z' }
  });
  assert.deepEqual(buckets.map((bucket) => bucket.family), ['fable', 'opus']);
  assert.equal(buckets[0].bucket, 'seven_day_fable');
  assert.equal(buckets[0].utilization, 60);
  assert.equal(buckets[0].resetAt, '2026-11-12T00:00:00Z');
});

test('unknown family keys are kept, malformed ones are skipped', () => {
  const buckets = listModelFamilyBuckets({
    seven_day_haiku: { utilization: 5 },
    seven_day_new_family: { utilization: 5 },
    seven_day_Opus: { utilization: 5 },
    seven_day_9lives: { utilization: 5 },
    seven_day_broken: { utilization: 'nope' },
    seven_day_missing: null
  });
  assert.deepEqual(
    buckets.map((bucket) => bucket.family),
    ['9lives', 'haiku', 'new_family']
  );
});

test('non-object payloads yield no buckets', () => {
  assert.deepEqual(listModelFamilyBuckets(null), []);
  assert.deepEqual(listModelFamilyBuckets([]), []);
  assert.deepEqual(listModelFamilyBuckets('x'), []);
});

test('plan type prefers the boolean conclusions', () => {
  assert.equal(claudePlanType({
    account: { has_claude_max: true, has_claude_pro: true },
    organization: { organization_type: 'claude_team' }
  }), 'max');
  assert.equal(claudePlanType({
    account: { has_claude_pro: true },
    organization: { organization_type: 'claude_enterprise' }
  }), 'pro');
});

test('plan type derives from organization_type without a whitelist', () => {
  assert.equal(claudePlanType({ organization: { organization_type: 'claude_team' } }), 'team');
  assert.equal(claudePlanType({ organization: { organization_type: 'claude_enterprise' } }), 'enterprise');
  assert.equal(claudePlanType({ organization: { organization_type: 'claude_fable' } }), 'fable');
  assert.equal(claudePlanType({ organization: { organization_type: 'Claude Fable' } }), 'fable');
  assert.equal(claudePlanType({ organization: { organization_type: 'Fable Max' } }), 'fable_max');
  assert.equal(claudePlanType({ organization: { organization_type: 'claude_new_tier' } }), 'new_tier');
});

test('plan type is empty for non-plan values', () => {
  assert.equal(claudePlanType({}), '');
  assert.equal(claudePlanType(null), '');
  assert.equal(claudePlanType({ organization: { organization_type: 'oauth' } }), '');
  assert.equal(claudePlanType({ organization: { organization_type: 'api-key' } }), '');
  assert.equal(claudePlanType({ organization: { organization_type: 'pending' } }), '');
});
