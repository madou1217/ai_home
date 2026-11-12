'use strict';

// 配额策略的套餐归一：不维护档位清单，上游新增套餐必须原样通过。
// 档位表只用于「是否升级」的比较，不是识别门槛。

const test = require('node:test');
const assert = require('node:assert/strict');

const { getQuotaResetStrategy } = require('../lib/account/quota-reset/strategy-registry');

test('every provider keeps unknown plan tiers', () => {
  for (const provider of ['claude', 'codex', 'kimi', 'zcode', 'agy']) {
    const strategy = getQuotaResetStrategy(provider);
    assert.equal(
      strategy.normalizePlanType('Fable Max'),
      'fable_max',
      `${provider} 必须让新档位原样通过`
    );
  }
});

test('known tiers still normalize the same way', () => {
  assert.equal(getQuotaResetStrategy('claude').normalizePlanType('Max'), 'max');
  assert.equal(getQuotaResetStrategy('claude').normalizePlanType('claude_team'), 'claude_team');
  assert.equal(getQuotaResetStrategy('codex').normalizePlanType('Pro Lite'), 'pro_lite');
  assert.equal(getQuotaResetStrategy('kimi').normalizePlanType('LEVEL_INTERMEDIATE'), 'level_intermediate');
  assert.equal(getQuotaResetStrategy('zcode').normalizePlanType('ZCode Start Plan'), 'zcode_start_plan');
  // agy 保留关键字归类（上游档位名带前后缀）。
  assert.equal(getQuotaResetStrategy('agy').normalizePlanType('Google AI Ultra'), 'ultra');
  assert.equal(getQuotaResetStrategy('agy').normalizePlanType('gemini-pro'), 'pro');
});

test('non-plan auth modes and placeholders never become plans', () => {
  for (const provider of ['claude', 'codex', 'kimi', 'zcode', 'agy']) {
    const strategy = getQuotaResetStrategy(provider);
    for (const value of ['oauth', 'oauth-browser', 'api-key', 'pending', 'unknown', '', null]) {
      assert.equal(strategy.normalizePlanType(value), null, `${provider} 不能把 ${value} 当套餐`);
    }
  }
});

test('unknown tiers keep a defined rank only for known tiers', () => {
  const strategy = getQuotaResetStrategy('claude');
  assert.equal(strategy.getPlanTierRank('max'), 5);
  assert.equal(strategy.getPlanTierRank('fable_max'), undefined);
});
