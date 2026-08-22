'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeAccountUsageSnapshot } = require('../lib/server/account-usage-view');

function codexSnapshot(extra = {}) {
  return {
    kind: 'codex_oauth_status',
    capturedAt: 1_700_000_000_000,
    entries: [{
      bucket: 'primary',
      windowMinutes: 300,
      window: '5h',
      remainingPct: 80,
      resetIn: '2h',
      resetAtMs: 1_700_000_100_000
    }],
    ...extra
  };
}

test('normalizeAccountUsageSnapshot keeps the Codex reset-credit available count for WebUI menus', () => {
  const normalized = normalizeAccountUsageSnapshot(codexSnapshot({
    rateLimitResetCredits: { availableCount: 4 }
  }));

  assert.equal(normalized.resetCreditsAvailableCount, 4);
  assert.equal(Object.hasOwn(normalized, 'rateLimitResetCredits'), false);
});

test('normalizeAccountUsageSnapshot omits reset-credit metadata when Codex did not return it', () => {
  const normalized = normalizeAccountUsageSnapshot(codexSnapshot());

  assert.equal(Object.hasOwn(normalized, 'resetCreditsAvailableCount'), false);
  assert.equal(Object.hasOwn(normalized, 'rateLimitResetCredits'), false);
});

test('normalizeAccountUsageSnapshot does not add reset-credit metadata to other providers', () => {
  const normalized = normalizeAccountUsageSnapshot({
    kind: 'claude_oauth_usage',
    capturedAt: 1,
    rateLimitResetCredits: { availableCount: 9 },
    entries: [{ bucket: 'five_hour', window: '5h', remainingPct: 50 }]
  });

  assert.equal(Object.hasOwn(normalized, 'resetCreditsAvailableCount'), false);
  assert.equal(Object.hasOwn(normalized, 'rateLimitResetCredits'), false);
});
