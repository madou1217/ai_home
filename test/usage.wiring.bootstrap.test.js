const test = require('node:test');
const assert = require('node:assert/strict');
const { createUsageWiring } = require('../lib/cli/bootstrap/usage-wiring');

test('createUsageWiring composes cache/snapshot/runtime/presenter services deterministically', () => {
  const calls = {
    cacheArg: null,
    snapshotArg: null,
    runtimeArg: null,
    presenterArg: null
  };

  const fakeReadUsageCache = () => null;
  const fakeEnsureUsageSnapshot = async () => ({ ok: true });
  const fakeGetToolAccountIds = () => ['10086'];
  const fakeGetMinRemainingPctFromCache = () => 42;
  const fakeIsExhausted = () => false;

  const out = createUsageWiring({
    fs: {},
    path: {},
    spawnSync: () => ({}),
    fetchImpl: () => Promise.resolve({ ok: true }),
    processObj: { env: {} },
    resolveCliPath: () => '/bin/codex',
    getProfileDir: () => '/tmp/profile',
    getToolConfigDir: () => '/tmp/tool',
    profilesDir: '/tmp/profiles',
    cliConfigs: {},
    createUsageScheduler: () => ({}),
    getAccountStateIndex: () => ({}),
    stateIndexClient: {},
    lastActiveAccountByCli: {},
    checkStatus: () => ({ configured: true }),
    getDefaultParallelism: () => 4,
    usageSnapshotSchemaVersion: 2,
    usageRefreshStaleMs: 10,
    usageIndexStaleRefreshMs: 20,
    usageIndexBgRefreshLimit: 5,
    usageCacheMaxAgeMs: 30,
    usageSourceGemini: 'g',
    usageSourceCodex: 'c',
    usageSourceClaudeOauth: 'co',
    usageSourceClaudeAuthToken: 'ct'
  }, {
    createUsageCacheService: (arg) => {
      calls.cacheArg = arg;
      return {
        getUsageCachePath: () => '/tmp/u.json',
        writeUsageCache: () => {},
        readUsageCache: fakeReadUsageCache
      };
    },
    createUsageSnapshotService: (arg) => {
      calls.snapshotArg = arg;
      return {
        ensureUsageSnapshot: fakeEnsureUsageSnapshot,
        getClaudeUsageAuthForSandbox: () => null
      };
    },
    createUsageAccountRuntimeService: (arg) => {
      calls.runtimeArg = arg;
      return {
        extractActiveEnv: () => ({}),
        findEnvSandbox: () => ({}),
        isExhausted: fakeIsExhausted,
        clearExhausted: () => {},
        syncExhaustedStateFromUsage: () => {},
        getUsageRemainingPercentValues: () => [90],
        getMinRemainingPctFromCache: fakeGetMinRemainingPctFromCache,
        refreshIndexedStateForAccount: () => {},
        filterExistingAccountIds: () => [],
        refreshAccountStateIndexForProvider: () => {},
        ensureAccountUsageRefreshScheduler: () => {},
        getToolAccountIds: fakeGetToolAccountIds
      };
    },
    createUsagePresenterService: (arg) => {
      calls.presenterArg = arg;
      return {
        formatUsageLabel: () => 'ok',
        printUsageSnapshot: () => {},
        buildUsageProbePayload: () => ({ ok: true }),
        printAllUsageSnapshots: () => {}
      };
    }
  });

  assert.equal(typeof out.getUsageCachePath, 'function');
  assert.equal(typeof out.ensureUsageSnapshot, 'function');
  assert.equal(typeof out.getToolAccountIds, 'function');
  assert.equal(typeof out.buildUsageProbePayload, 'function');

  assert.equal(calls.cacheArg.usageSnapshotSchemaVersion, 2);
  assert.equal(calls.snapshotArg.readUsageCache, fakeReadUsageCache);
  assert.equal(typeof calls.snapshotArg.fetchImpl, 'function');
  assert.equal(calls.runtimeArg.ensureUsageSnapshot, fakeEnsureUsageSnapshot);
  assert.equal(calls.presenterArg.getToolAccountIds, fakeGetToolAccountIds);
  assert.deepEqual(calls.presenterArg.processObj, { env: {} });
  assert.equal(calls.presenterArg.isExhausted, fakeIsExhausted);
  assert.equal(calls.presenterArg.getMinRemainingPctFromCache, fakeGetMinRemainingPctFromCache);
});
