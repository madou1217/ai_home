const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveAccountPlanLabel } = require('../lib/cli/services/profile/account-plan-badge');

test('resolveAccountPlanLabel formats Claude OAuth plans from explicit metadata', () => {
  assert.equal(resolveAccountPlanLabel({ provider: 'claude', planType: 'pro' }), 'Pro');
  assert.equal(resolveAccountPlanLabel({ provider: 'claude', planType: 'max' }), 'Max');
  assert.equal(resolveAccountPlanLabel({
    provider: 'claude',
    planType: 'max',
    rateLimitTier: 'default_claude_max_5x'
  }), 'Max 5x');
  assert.equal(resolveAccountPlanLabel({
    provider: 'claude',
    planType: 'max',
    rateLimitTier: 'default_claude_max_20x'
  }), 'Max 20x');
});

test('resolveAccountPlanLabel formats known Codex plans without inferring multipliers', () => {
  assert.equal(resolveAccountPlanLabel({ provider: 'codex', planType: 'plus' }), 'Plus');
  assert.equal(resolveAccountPlanLabel({ provider: 'codex', planType: 'pro' }), 'Pro');
  assert.equal(resolveAccountPlanLabel({ provider: 'codex', planType: 'prolite' }), 'Pro Lite');
  assert.equal(resolveAccountPlanLabel({ provider: 'codex', planType: 'team' }), 'Team');
  assert.equal(resolveAccountPlanLabel({
    provider: 'codex',
    planType: 'enterprise_cbp_usage_based'
  }), 'Enterprise');
});

test('resolveAccountPlanLabel hides free, unknown, unsupported and API-key plans', () => {
  assert.equal(resolveAccountPlanLabel({ provider: 'codex', planType: 'free' }), '');
  assert.equal(resolveAccountPlanLabel({ provider: 'claude', planType: 'unknown' }), '');
  assert.equal(resolveAccountPlanLabel({ provider: 'codex', planType: 'future_plan' }), '');
  assert.equal(resolveAccountPlanLabel({
    provider: 'claude',
    planType: 'pro',
    apiKeyMode: true
  }), '');
});
