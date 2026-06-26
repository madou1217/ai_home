const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeAccountUsageSnapshot } = require('../lib/server/account-usage-view');

test('normalizeAccountUsageSnapshot keeps claude_oauth_usage entries for the WebUI', () => {
  const snapshot = {
    kind: 'claude_oauth_usage',
    capturedAt: 1700000000000,
    source: 'claude_oauth',
    entries: [
      { bucket: 'five_hour', windowMinutes: 300, window: '5h', remainingPct: 73.2, resetIn: '2h', resetAtMs: 111 },
      { bucket: 'seven_day', windowMinutes: 10080, window: '7days', remainingPct: 88, resetIn: '3d', resetAtMs: 222 }
    ]
  };

  const normalized = normalizeAccountUsageSnapshot(snapshot);
  assert.equal(normalized.kind, 'claude_oauth_usage');
  assert.equal(normalized.capturedAt, 1700000000000);
  assert.equal(normalized.entries.length, 2);
  assert.deepEqual(normalized.entries[0], {
    bucket: 'five_hour',
    windowMinutes: 300,
    window: '5h',
    remainingPct: 73.2,
    resetIn: '2h',
    resetAtMs: 111
  });
  assert.equal(normalized.entries[1].remainingPct, 88);
});

test('normalizeAccountUsageSnapshot keeps the claude profile account identity', () => {
  const normalized = normalizeAccountUsageSnapshot({
    kind: 'claude_oauth_usage',
    capturedAt: 1,
    account: { email: 'madou1217@gmail.com', fullName: 'HorseBean', planType: 'pro' },
    entries: [{ bucket: 'five_hour', window: '5h', remainingPct: 50 }]
  });
  assert.deepEqual(normalized.account, {
    email: 'madou1217@gmail.com',
    fullName: 'HorseBean',
    planType: 'pro'
  });
});

test('normalizeAccountUsageSnapshot leaves claude account null when absent', () => {
  const normalized = normalizeAccountUsageSnapshot({
    kind: 'claude_oauth_usage',
    capturedAt: 1,
    entries: [{ bucket: 'five_hour', window: '5h', remainingPct: 50 }]
  });
  assert.equal(normalized.account, null);
});

test('normalizeAccountUsageSnapshot coerces invalid claude remainingPct to null', () => {
  const normalized = normalizeAccountUsageSnapshot({
    kind: 'claude_oauth_usage',
    capturedAt: 0,
    entries: [{ bucket: '', window: '5h', remainingPct: 'not-a-number' }]
  });
  assert.equal(normalized.entries[0].remainingPct, null);
});
