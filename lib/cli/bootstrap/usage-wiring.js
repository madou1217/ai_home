'use strict';

const { createUsageCacheService } = require('../services/usage/cache');
const { createUsageSnapshotService } = require('../services/usage/snapshot');
const { createUsageAccountRuntimeService } = require('../services/usage/account-runtime');
const { createUsagePresenterService } = require('../services/usage/presenter');

function createUsageWiring(deps = {}, factories = {}) {
  const buildUsageCacheService = factories.createUsageCacheService || createUsageCacheService;
  const buildUsageSnapshotService = factories.createUsageSnapshotService || createUsageSnapshotService;
  const buildUsageAccountRuntimeService = factories.createUsageAccountRuntimeService || createUsageAccountRuntimeService;
  const buildUsagePresenterService = factories.createUsagePresenterService || createUsagePresenterService;

  const usageCacheService = buildUsageCacheService({
    fs: deps.fs,
    path: deps.path,
    getProfileDir: deps.getProfileDir,
    usageSnapshotSchemaVersion: deps.usageSnapshotSchemaVersion,
    usageSourceGemini: deps.usageSourceGemini,
    usageSourceCodex: deps.usageSourceCodex,
    usageSourceClaudeOauth: deps.usageSourceClaudeOauth,
    usageSourceClaudeAuthToken: deps.usageSourceClaudeAuthToken
  });
  const { getUsageCachePath, writeUsageCache, readUsageCache } = usageCacheService;

  const usageSnapshotService = buildUsageSnapshotService({
    fs: deps.fs,
    path: deps.path,
    spawn: deps.spawn,
    spawnSync: deps.spawnSync,
    fetchImpl: deps.fetchImpl,
    processObj: deps.processObj,
    resolveCliPath: deps.resolveCliPath,
    usageSnapshotSchemaVersion: deps.usageSnapshotSchemaVersion,
    usageRefreshStaleMs: deps.usageRefreshStaleMs,
    usageSourceGemini: deps.usageSourceGemini,
    usageSourceCodex: deps.usageSourceCodex,
    usageSourceClaudeOauth: deps.usageSourceClaudeOauth,
    usageSourceClaudeAuthToken: deps.usageSourceClaudeAuthToken,
    getProfileDir: deps.getProfileDir,
    getToolConfigDir: deps.getToolConfigDir,
    writeUsageCache,
    readUsageCache
  });
  const {
    ensureUsageSnapshot,
    ensureUsageSnapshotAsync,
    getClaudeUsageAuthForSandbox,
    getLastUsageProbeError
  } = usageSnapshotService;

  const usageAccountRuntimeService = buildUsageAccountRuntimeService({
    path: deps.path,
    fs: deps.fs,
    profilesDir: deps.profilesDir,
    cliConfigs: deps.cliConfigs,
    createUsageScheduler: deps.createUsageScheduler,
    getAccountStateIndex: deps.getAccountStateIndex,
    stateIndexClient: deps.stateIndexClient,
    lastActiveAccountByCli: deps.lastActiveAccountByCli,
    usageIndexStaleRefreshMs: deps.usageIndexStaleRefreshMs,
    usageIndexBgRefreshLimit: deps.usageIndexBgRefreshLimit,
    getProfileDir: deps.getProfileDir,
    checkStatus: deps.checkStatus,
    readUsageCache,
    ensureUsageSnapshot
  });
  const {
    extractActiveEnv,
    findEnvSandbox,
    isExhausted,
    clearExhausted,
    syncExhaustedStateFromUsage,
    getUsageRemainingPercentValues,
    getMinRemainingPctFromCache,
    refreshIndexedStateForAccount,
    filterExistingAccountIds,
    refreshAccountStateIndexForProvider,
    ensureAccountUsageRefreshScheduler,
    getToolAccountIds
  } = usageAccountRuntimeService;

  const usagePresenterService = buildUsagePresenterService({
    processObj: deps.processObj,
    usageCacheMaxAgeMs: deps.usageCacheMaxAgeMs,
    readUsageCache,
    ensureUsageSnapshot,
    ensureUsageSnapshotAsync,
    getClaudeUsageAuthForSandbox,
    getLastUsageProbeError,
    checkStatus: deps.checkStatus,
    getProfileDir: deps.getProfileDir,
    filterExistingAccountIds,
    getAccountStateIndex: deps.getAccountStateIndex,
    getToolAccountIds,
    getDefaultParallelism: deps.getDefaultParallelism,
    stateIndexClient: deps.stateIndexClient,
    isExhausted,
    getMinRemainingPctFromCache
  });
  const {
    formatUsageLabel,
    printUsageSnapshot,
    printUsageSnapshotAsync,
    buildUsageProbePayload,
    buildUsageProbePayloadAsync,
    printAllUsageSnapshots
  } = usagePresenterService;

  return {
    getUsageCachePath,
    writeUsageCache,
    readUsageCache,
    ensureUsageSnapshot,
    ensureUsageSnapshotAsync,
    getClaudeUsageAuthForSandbox,
    getLastUsageProbeError,
    extractActiveEnv,
    findEnvSandbox,
    isExhausted,
    clearExhausted,
    syncExhaustedStateFromUsage,
    getUsageRemainingPercentValues,
    getMinRemainingPctFromCache,
    refreshIndexedStateForAccount,
    filterExistingAccountIds,
    refreshAccountStateIndexForProvider,
    ensureAccountUsageRefreshScheduler,
    getToolAccountIds,
    formatUsageLabel,
    printUsageSnapshot,
    printUsageSnapshotAsync,
    buildUsageProbePayload,
    buildUsageProbePayloadAsync,
    printAllUsageSnapshots
  };
}

module.exports = {
  createUsageWiring
};
