const test = require('node:test');
const assert = require('node:assert/strict');

const {
  deriveQuotaState,
  getMinRemainingPctFromUsageSnapshot,
  getUsageRemainingPctValues
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
