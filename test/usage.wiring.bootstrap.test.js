const test = require('node:test');
const assert = require('node:assert/strict');
const { createUsageWiring } = require('../lib/cli/bootstrap/usage-wiring');

test('createUsageWiring composes cache/snapshot/runtime/presenter services deterministically', () => {
  const calls = {
    cacheArg: null,
    reconcilerArg: null,
    snapshotArg: null,
    runtimeArg: null,
    presenterArg: null
  };

  const fakeReadUsageCache = () => null;
  const fakeEnsureUsageSnapshot = async () => ({ ok: true });
  const fakeBuildAgyUsagePreflight = () => ({ ok: true });
  const fakeGetToolAccountIds = () => ['10086'];
  const fakeGetMinRemainingPctFromCache = () => 42;
  const fakeGetAccountQuotaState = () => ({ quotaStatus: 'available' });

  const out = createUsageWiring({
    fs: {},
    path: {},
    spawnSync: () => ({}),
    fetchImpl: () => Promise.resolve({ ok: true }),
    processObj: { env: {} },
    resolveCliPath: () => '/bin/codex',
    getProfileDir: () => '/tmp/profile',
    getToolConfigDir: () => '/tmp/tool',
    aiHomeDir: '/tmp/aih',
    profilesDir: '/tmp/profiles',
    cliConfigs: {},
    createUsageScheduler: () => ({}),
    getAccountStateIndex: () => ({}),
    accountStateService: {},
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
    usageSourceClaudeAuthToken: 'ct',
    usageSourceAgyCodeAssist: 'agy_fetch_available_models',
    refreshAgyAccessToken: () => ({ ok: true }),
    fetchWithTimeout: () => Promise.resolve({ ok: true })
  }, {
    createUsageCacheService: (arg) => {
      calls.cacheArg = arg;
      return {
        getUsageCachePath: () => '/tmp/u.json',
        writeUsageCache: () => {},
        readUsageCache: fakeReadUsageCache
      };
    },
    createCodexAuthInvalidReconciler: (arg) => {
      calls.reconcilerArg = arg;
      return { enqueueUsageProbeFailure: () => false };
    },
    createUsageSnapshotService: (arg) => {
      calls.snapshotArg = arg;
      return {
        ensureUsageSnapshot: fakeEnsureUsageSnapshot,
        buildAgyUsagePreflight: fakeBuildAgyUsagePreflight,
        getClaudeUsageAuthForSandbox: () => null
      };
    },
    createUsageAccountRuntimeService: (arg) => {
      calls.runtimeArg = arg;
      return {
        extractActiveEnv: () => ({}),
        findEnvSandbox: () => ({}),
        getAccountQuotaState: fakeGetAccountQuotaState,
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
  assert.equal(calls.cacheArg.usageSourceAgyCodeAssist, 'agy_fetch_available_models');
  assert.equal(calls.reconcilerArg.accountStateService, calls.snapshotArg.accountStateService);
  assert.equal(calls.reconcilerArg.aiHomeDir, '/tmp/aih');
  assert.equal(typeof calls.reconcilerArg.fetchWithTimeout, 'function');
  assert.equal(calls.snapshotArg.readUsageCache, fakeReadUsageCache);
  assert.equal(typeof calls.snapshotArg.codexAuthInvalidReconciler.enqueueUsageProbeFailure, 'function');
  assert.equal(typeof calls.snapshotArg.fetchImpl, 'function');
  assert.equal(calls.snapshotArg.usageSourceAgyCodeAssist, 'agy_fetch_available_models');
  assert.equal(typeof calls.snapshotArg.refreshAgyAccessToken, 'function');
  assert.equal(typeof calls.snapshotArg.fetchWithTimeout, 'function');
  assert.equal(calls.runtimeArg.ensureUsageSnapshot, fakeEnsureUsageSnapshot);
  assert.equal(calls.presenterArg.buildAgyUsagePreflight, fakeBuildAgyUsagePreflight);
  assert.equal(calls.presenterArg.getToolAccountIds, fakeGetToolAccountIds);
  assert.deepEqual(calls.presenterArg.processObj, { env: {} });
  assert.equal(calls.presenterArg.getAccountQuotaState, fakeGetAccountQuotaState);
  assert.equal(calls.presenterArg.getMinRemainingPctFromCache, fakeGetMinRemainingPctFromCache);
  assert.equal(typeof calls.presenterArg.codexAuthInvalidReconciler.enqueueUsageProbeFailure, 'function');
});
