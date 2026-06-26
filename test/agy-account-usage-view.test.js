const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildAgyEffectiveUsageView,
  normalizeAgyPlanType
} = require('../lib/server/agy-account-usage-view');

function buildAgySnapshot(subscriptionTier, planType = 'oauth') {
  return {
    schemaVersion: 2,
    kind: 'agy_code_assist_quota',
    source: 'agy_fetch_available_models',
    capturedAt: Date.now(),
    account: {
      email: 'agy@example.com',
      planType,
      subscriptionTier,
      project: 'projects/agy'
    },
    models: [
      {
        model: 'claude-opus-4-6-thinking',
        remainingPct: 100,
        resetIn: '24h',
        resetAtMs: Date.now() + 86_400_000
      },
      {
        model: 'gemini-3-flash',
        remainingPct: 100,
        resetIn: '24h',
        resetAtMs: Date.now() + 86_400_000
      }
    ],
    modelForwardingRules: {}
  };
}

test('normalizeAgyPlanType maps starter, pro, and ultra tiers', () => {
  assert.equal(normalizeAgyPlanType('Antigravity Starter Quota', 'oauth'), 'free');
  assert.equal(normalizeAgyPlanType('Google AI Pro', 'oauth'), 'pro');
  assert.equal(normalizeAgyPlanType('Google AI Ultra', 'oauth'), 'ultra');
  assert.equal(normalizeAgyPlanType('', 'oauth'), 'oauth');
});

test('buildAgyEffectiveUsageView treats free quota exhaustion as account-visible zero remaining', () => {
  const view = buildAgyEffectiveUsageView({
    usageSnapshot: buildAgySnapshot('Antigravity Starter Quota'),
    runtimeState: {
      lastFailureKind: 'model_quota_exhausted',
      lastFailureReason: 'HTTP 429 RESOURCE_EXHAUSTED Resource has been exhausted (e.g. check quota)',
      modelCooldowns: {
        'claude-opus-4-6-thinking': Date.now() + 60_000
      }
    }
  });

  assert.equal(view.planType, 'free');
  assert.equal(view.remainingPct, 0);
  assert.equal(view.freeQuotaExhausted, true);
  assert.deepEqual(view.usageSnapshot.models.map((model) => model.remainingPct), [0, 0]);
});

test('buildAgyEffectiveUsageView keeps free agy exhausted after failure text is cleared', () => {
  const view = buildAgyEffectiveUsageView({
    usageSnapshot: buildAgySnapshot('Antigravity Starter Quota'),
    runtimeState: {
      lastFailureKind: '',
      lastFailureReason: '',
      modelCooldowns: {
        'claude-opus-4-6-thinking': Date.now() + 60_000
      }
    }
  });

  assert.equal(view.planType, 'free');
  assert.equal(view.remainingPct, 0);
  assert.equal(view.freeQuotaExhausted, true);
  assert.equal(view.quotaExhaustionSignal, false);
  assert.deepEqual(view.usageSnapshot.models.map((model) => model.remainingPct), [0, 0]);
});

test('buildAgyEffectiveUsageView does not turn pro model cooldown into account exhaustion', () => {
  const snapshot = buildAgySnapshot('Google AI Pro');
  snapshot.models[0].remainingPct = 64;
  snapshot.models[1].remainingPct = 92;

  const view = buildAgyEffectiveUsageView({
    usageSnapshot: snapshot,
    runtimeState: {
      lastFailureKind: 'model_quota_exhausted',
      lastFailureReason: 'HTTP 429 RESOURCE_EXHAUSTED Resource has been exhausted (e.g. check quota)',
      modelCooldowns: {
        'claude-opus-4-6-thinking': Date.now() + 60_000
      }
    }
  });

  assert.equal(view.planType, 'pro');
  assert.equal(view.remainingPct, 64);
  assert.equal(view.freeQuotaExhausted, false);
  assert.deepEqual(view.usageSnapshot.models.map((model) => model.remainingPct), [64, 92]);
});
