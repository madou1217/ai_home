const test = require('node:test');
const assert = require('node:assert/strict');
const { createUsagePresenterService } = require('../lib/cli/services/usage/presenter');

function createPresenterHarness(overrides = {}) {
  const upserts = [];
  const options = {
    usageCacheMaxAgeMs: 24 * 60 * 60 * 1000,
    readUsageCache: overrides.readUsageCache || (() => null),
    ensureUsageSnapshot: overrides.ensureUsageSnapshot || ((_, __, cache) => cache),
    ensureUsageSnapshotAsync: overrides.ensureUsageSnapshotAsync || (async (_, __, cache) => cache),
    getClaudeUsageAuthForSandbox: () => null,
    getLastUsageProbeError: () => '',
    checkStatus: overrides.checkStatus || (() => ({ configured: true, accountName: 'tester@example.com' })),
    getProfileDir: () => '/tmp/.ai_home/profiles/codex/1',
    filterExistingAccountIds: (cliName, ids) => ids,
    getAccountStateIndex: () => ({ listStates: () => [] }),
    getToolAccountIds: overrides.getToolAccountIds || (() => ['1']),
    getDefaultParallelism: () => 10,
    stateIndexClient: {
      upsert: (_cliName, _id, payload) => upserts.push(payload)
    },
    isExhausted: () => false,
    getMinRemainingPctFromCache: (cache) => {
      if (!cache || !Array.isArray(cache.entries)) return null;
      const values = cache.entries
        .map((entry) => Number(entry && entry.remainingPct))
        .filter((value) => Number.isFinite(value));
      if (values.length === 0) return null;
      return Math.min(...values);
    },
    processObj: {
      env: {},
      stdout: { isTTY: false, write() {} }
    }
  };
  const service = createUsagePresenterService({ ...options, ...overrides });
  return { service, upserts };
}

test('buildUsageProbePayloadAsync carries minRemainingPct from refreshed snapshot', async () => {
  const snapshot = {
    capturedAt: Date.now(),
    kind: 'codex_oauth_status',
    entries: [
      { window: '5h', remainingPct: 42 },
      { window: '7days', remainingPct: 80 }
    ]
  };
  const { service } = createPresenterHarness({
    readUsageCache: () => null,
    ensureUsageSnapshotAsync: async () => snapshot
  });

  const payload = await service.buildUsageProbePayloadAsync('codex', '1');
  assert.equal(payload.status, 'ok');
  assert.equal(payload.minRemainingPct, 42);
});

test('printAllUsageSnapshots updates state from probe payload without re-reading cache', async () => {
  const snapshot = {
    capturedAt: Date.now(),
    kind: 'codex_oauth_status',
    entries: [
      { window: '5h', remainingPct: 42 },
      { window: '7days', remainingPct: 80 }
    ]
  };
  let readCalls = 0;
  const { service, upserts } = createPresenterHarness({
    readUsageCache: () => {
      readCalls += 1;
      return null;
    },
    ensureUsageSnapshotAsync: async () => snapshot
  });
  const oldLog = console.log;
  console.log = () => {};
  try {
    await service.printAllUsageSnapshots('codex', { jobs: 1 });
  } finally {
    console.log = oldLog;
  }

  assert.equal(readCalls, 1);
  assert.equal(upserts.length > 0, true);
  assert.deepEqual(upserts[0], {
    configured: true,
    apiKeyMode: false,
    exhausted: false,
    remainingPct: 42
  });
});
