const test = require('node:test');
const assert = require('node:assert/strict');
const { createAccountQuotaProbeScheduler, __private } = require('../lib/server/account-quota-probe-scheduler');

test('account quota probe scheduler exports defaults and creates running instance', () => {
  assert.equal(typeof __private.DEFAULT_SCHEDULER_INTERVAL_MS, 'number');
  assert.equal(typeof __private.PROBE_AHEAD_WINDOW_MS, 'number');

  let refreshedCount = 0;
  const scheduler = createAccountQuotaProbeScheduler({
    listAccounts: () => [
      {
        provider: 'agy',
        accountRef: 'acct_agy_1',
        apiKeyMode: false,
        usageSnapshot: {
          capturedAt: Date.now() - 20 * 60 * 1000,
          entries: [{ remainingPct: 80, resetAtMs: Date.now() + 60000 }]
        }
      }
    ],
    ensureUsageSnapshotAsync: async () => {
      refreshedCount++;
      return {};
    }
  }, { quotaProbeIntervalMs: 20000 });

  assert.equal(typeof scheduler.start, 'function');
  assert.equal(typeof scheduler.stop, 'function');
  assert.equal(typeof scheduler.tick, 'function');

  scheduler.start();
  scheduler.stop();
});

test('scheduler tick processes candidates near reset time', async () => {
  const probedRefs = [];
  const scheduler = createAccountQuotaProbeScheduler({
    listAccounts: () => [
      {
        provider: 'codex',
        accountRef: 'acct_codex_1',
        apiKeyMode: false,
        usageSnapshot: {
          capturedAt: Date.now() - 10000,
          entries: [{ remainingPct: 20, resetAtMs: Date.now() + 60000 }]
        }
      }
    ],
    ensureUsageSnapshotAsync: async (provider, ref) => {
      probedRefs.push(ref);
      return {};
    }
  });

  await scheduler.tick();
  assert.deepEqual(probedRefs, ['acct_codex_1']);
});
