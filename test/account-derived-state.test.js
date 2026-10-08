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
  for (const provider of ['opencode', 'qoder', 'qodercn']) {
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

test('Kiro quota uses official credits independently of account scheduling status', () => {
  const state = deriveQuotaState({ provider: 'kiro', configured: true, apiKeyMode: false,
    usageSnapshot: { kind: 'kiro_credit_usage', entries: [{ remainingPct: 99.74 }] } });
  assert.equal(state.status, 'available');
  assert.equal(state.remainingPct, 99.74);
  assert.equal(deriveQuotaState({ provider: 'kiro', configured: true }).status, 'pending');
});

test('derived state treats Grok as quota-capable while its billing snapshot is pending', () => {
  const quotaState = deriveQuotaState({ provider: 'grok', configured: true, apiKeyMode: false });
  const schedulableState = deriveSchedulableState({
    provider: 'grok',
    configured: true,
    apiKeyMode: false,
    quotaState
  });

  assert.equal(quotaState.status, 'pending');
  assert.equal(schedulableState.status, 'schedulable');

  const unknownBilling = deriveQuotaState({
    provider: 'grok', configured: true, apiKeyMode: false,
    usageSnapshot: { kind: 'grok_credit_usage', entries: [{ remainingPct: null, windowMinutes: 10_080 }] }
  });
  assert.equal(unknownBilling.status, 'pending');
  assert.equal(unknownBilling.reason, 'provider_returned_no_numeric_usage');
  assert.equal(unknownBilling.remainingPct, null);
  assert.equal(deriveSchedulableState({ provider: 'grok', configured: true, quotaState: unknownBilling }).status, 'schedulable');
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

test('a failed quota refresh remains visible while preserving historical balances', () => {
  for (const provider of ['zcode', 'workbuddy', 'workbuddycn', 'codex']) {
    const options = { provider, configured: true, remainingPct: 82, probeError: 'upstream_timeout' };
    const state = deriveQuotaState(options);
    assert.equal(state.status, 'probe_failed', provider);
    assert.equal(state.reason, 'upstream_timeout', provider);
    assert.equal(state.remainingPct, 82, provider);
    assert.equal(deriveSchedulableState({ ...options, quotaState: state }).status, 'schedulable', provider);
    assert.equal(deriveQuotaState({ ...options, probeError: '' }).status, 'available', provider);
  }
});

test('a failed quota refresh never reopens an account with a known exhausted balance', () => {
  const options = { provider: 'codex', configured: true, remainingPct: 0, probeError: 'upstream_timeout' };
  const state = deriveQuotaState(options);
  assert.equal(state.status, 'exhausted');
  assert.equal(state.remainingPct, 0);
  assert.equal(deriveSchedulableState({ ...options, quotaState: state }).status, 'blocked_by_quota');
});

test('a current unknown quota snapshot cannot inherit a legacy exhausted balance or switch threshold', () => {
  for (const [provider, kind, field] of [
    ['grok', 'grok_credit_usage', 'entries'], ['codex', 'codex_oauth_status', 'entries'],
    ['workbuddy', 'codebuddy_credit_balance', 'entries'], ['zcode', 'zcode_plan_balance', 'entries'],
    ['agy', 'agy_code_assist_quota', 'models']
  ]) {
    for (const remainingPct of [0, 10]) {
      const options = { provider, configured: true, remainingPct, usageThresholdPct: 80,
        usageSnapshot: { kind, [field]: [{ remainingPct: null, windowMinutes: 10080 }] } };
      const quotaState = deriveQuotaState(options);
      assert.equal(quotaState.status, 'pending', provider);
      assert.equal(quotaState.remainingPct, null, provider);
      assert.equal(deriveSchedulableState({ ...options, quotaState }).status, 'schedulable', provider);
    }
  }
});

test('legacy missing-rate-limit diagnostics do not block a configured Codex account', () => {
  for (const planType of ['team', 'free']) {
    const state = deriveSchedulableState({ provider: 'codex', configured: true, planType,
      usageSnapshot: { kind: 'codex_oauth_status', fallbackSource: 'account_read', entries: [] },
      quotaState: { status: 'provider_unavailable', reason: `codex_${planType}_plan_missing_rate_limits`, remainingPct: null } });
    assert.equal(state.status, 'schedulable', planType);
  }
});

test('relay policy stays blocked even with available quota or an API key', () => {
  const options = {
    provider: 'zcode', configured: true, remainingPct: 90,
    relayDisabled: true, relayDisabledReason: 'zcode_oauth_management_only'
  };
  for (const apiKeyMode of [false, true]) {
    assert.deepEqual(deriveSchedulableState({ ...options, apiKeyMode }), {
      status: 'blocked_by_policy', reason: 'zcode_oauth_management_only'
    });
  }
  assert.equal(deriveSchedulableState({ ...options, relayDisabled: false }).status, 'schedulable');
});

test('account and runtime failures keep precedence over relay policy', () => {
  const options = { configured: true, relayDisabled: true, relayDisabledReason: 'relay_disabled' };
  for (const [override, reason] of [
    [{ configured: false }, 'account_unconfigured'],
    [{ accountStatus: 'down' }, 'account_disabled'],
    [{ runtimeStatus: 'auth_invalid' }, 'auth_invalid']
  ]) {
    assert.equal(deriveSchedulableState({ ...options, ...override }).reason, reason);
  }
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
