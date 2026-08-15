const test = require('node:test');
const assert = require('node:assert/strict');

const {
  deriveQuotaState,
  deriveSchedulableState,
  getMinRemainingPctFromUsageSnapshot,
  getUsageRemainingPctValues,
  resolveMinimumRemainingPct
} = require('../lib/account/derived-state');

test('derived state uses AGY Code Assist model quota snapshots', () => {
  const snapshot = {
    kind: 'agy_code_assist_quota',
    models: [
      { model: 'claude-sonnet-4-6', remainingPct: 64 },
      { model: 'gemini-3.5-flash-high', remainingPct: 18 }
    ]
  };

  assert.deepEqual(getUsageRemainingPctValues(snapshot), [64, 18]);
  assert.equal(getMinRemainingPctFromUsageSnapshot(snapshot), 18);

  const state = deriveQuotaState({
    provider: 'agy',
    configured: true,
    apiKeyMode: false,
    usageSnapshot: snapshot
  });

  assert.equal(state.status, 'available');
  assert.equal(state.remainingPct, 18);
  assert.equal(state.hasNumericRemaining, true);
});

test('derived state marks exhausted AGY Code Assist quota as exhausted', () => {
  const state = deriveQuotaState({
    provider: 'agy',
    configured: true,
    apiKeyMode: false,
    usageSnapshot: {
      kind: 'agy_code_assist_quota',
      models: [
        { model: 'claude-sonnet-4-6', remainingPct: 0 }
      ]
    }
  });

  assert.equal(state.status, 'exhausted');
  assert.equal(state.remainingPct, 0);
});

test('derived state marks Codex account exhausted when any usage window is zero', () => {
  const snapshot = {
    kind: 'codex_oauth_status',
    entries: [
      { window: '5h', windowMinutes: 300, remainingPct: 0 },
      { window: '7days', windowMinutes: 10080, remainingPct: 75 }
    ]
  };

  assert.equal(getMinRemainingPctFromUsageSnapshot(snapshot), 0);

  const state = deriveQuotaState({
    provider: 'codex',
    configured: true,
    apiKeyMode: false,
    usageSnapshot: snapshot
  });

  assert.equal(state.status, 'exhausted');
  assert.equal(state.remainingPct, 0);
});

test('derived state uses Kimi OAuth usage windows', () => {
  const snapshot = {
    kind: 'kimi_oauth_usage',
    entries: [
      { window: '7days', windowMinutes: 10080, remainingPct: 72 },
      { window: '5h', windowMinutes: 300, remainingPct: 31 }
    ]
  };

  assert.deepEqual(getUsageRemainingPctValues(snapshot), [72, 31]);
  assert.equal(getMinRemainingPctFromUsageSnapshot(snapshot), 31);

  const state = deriveQuotaState({
    provider: 'kimi',
    configured: true,
    apiKeyMode: false,
    usageSnapshot: snapshot
  });

  assert.equal(state.status, 'available');
  assert.equal(state.remainingPct, 31);
  assert.equal(state.hasNumericRemaining, true);
});

test('derived state treats OpenCode auth as not requiring quota collection', () => {
  const state = deriveQuotaState({
    provider: 'opencode',
    configured: true,
    apiKeyMode: false
  });

  assert.equal(state.status, 'not_applicable');
  assert.equal(state.remainingPct, null);
  assert.equal(state.hasNumericRemaining, false);
});

test('derived state treats providers without quota usage as schedulable', () => {
  for (const provider of ['opencode', 'grok', 'qoder', 'qodercn', 'kiro']) {
    const quotaState = deriveQuotaState({ provider, configured: true, apiKeyMode: false });
    const schedulableState = deriveSchedulableState({
      provider,
      configured: true,
      apiKeyMode: false,
      quotaState
    });
    assert.equal(quotaState.status, 'not_applicable');
    assert.equal(schedulableState.status, 'schedulable');
  }
});

test('derived state treats kimi as quota-capable (OAuth 配额探测已接入)', () => {
  // kimi 声明 quota_usage 能力后：无快照时 pending（等待探测），有数值时按额度调度。
  const pending = deriveQuotaState({ provider: 'kimi', configured: true, apiKeyMode: false });
  assert.equal(pending.status, 'pending');
  const available = deriveQuotaState({ provider: 'kimi', configured: true, apiKeyMode: false, remainingPct: 54 });
  assert.equal(available.status, 'available');
  assert.equal(available.remainingPct, 54);
});

test('derived state keeps Kimi OAuth quota pending until a usage snapshot exists', () => {
  const quotaState = deriveQuotaState({
    provider: 'kimi',
    configured: true,
    apiKeyMode: false
  });
  const schedulableState = deriveSchedulableState({
    provider: 'kimi',
    configured: true,
    apiKeyMode: false,
    quotaState
  });

  assert.equal(quotaState.status, 'pending');
  assert.equal(schedulableState.status, 'schedulable');
});

test('derived state blocks a non-exhausted Codex Free account at the configured switch threshold', () => {
  const state = deriveSchedulableState({
    provider: 'codex',
    configured: true,
    apiKeyMode: false,
    planType: 'free',
    remainingPct: 10,
    usageThresholdPct: 80
  });

  assert.equal(state.status, 'blocked_by_policy');
  assert.equal(state.reason, 'codex_free_plan_below_server_min_remaining');
});

test('derived state leaves a Codex Free account schedulable above the configured switch threshold', () => {
  const state = deriveSchedulableState({
    provider: 'codex',
    configured: true,
    apiKeyMode: false,
    planType: 'free',
    remainingPct: 10,
    usageThresholdPct: 95
  });

  assert.equal(state.status, 'schedulable');
  assert.equal(state.reason, '');
});

test('minimum remaining percentage is clamped to the inclusive 0..100 boundary', () => {
  assert.equal(resolveMinimumRemainingPct(-1), 100);
  assert.equal(resolveMinimumRemainingPct(0), 100);
  assert.equal(resolveMinimumRemainingPct(100), 0);
  assert.equal(resolveMinimumRemainingPct(101), 0);
  assert.equal(resolveMinimumRemainingPct('invalid'), null);
});
