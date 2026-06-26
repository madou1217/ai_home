'use strict';

const { createUsageCacheService } = require('../services/usage/cache');
const { createUsageSnapshotService } = require('../services/usage/snapshot');
const { createUsageAccountRuntimeService } = require('../services/usage/account-runtime');
const { createUsagePresenterService } = require('../services/usage/presenter');
const { createCodexAuthInvalidReconciler } = require('../services/usage/codex-auth-invalid-reconciler');

function createUsageWiring(deps = {}, factories = {}) {
  const buildUsageCacheService = factories.createUsageCacheService || createUsageCacheService;
  const buildUsageSnapshotService = factories.createUsageSnapshotService || createUsageSnapshotService;
  const buildUsageAccountRuntimeService = factories.createUsageAccountRuntimeService || createUsageAccountRuntimeService;
  const buildUsagePresenterService = factories.createUsagePresenterService || createUsagePresenterService;
  const buildCodexAuthInvalidReconciler = factories.createCodexAuthInvalidReconciler || createCodexAuthInvalidReconciler;

  const usageCacheService = buildUsageCacheService({
    fs: deps.fs,
    path: deps.path,
    getProfileDir: deps.getProfileDir,
    usageSnapshotSchemaVersion: deps.usageSnapshotSchemaVersion,
    usageSourceGemini: deps.usageSourceGemini,
    usageSourceCodex: deps.usageSourceCodex,
    usageSourceClaudeOauth: deps.usageSourceClaudeOauth,
    usageSourceClaudeAuthToken: deps.usageSourceClaudeAuthToken,
    usageSourceAgyCodeAssist: deps.usageSourceAgyCodeAssist
  });
  const { getUsageCachePath, writeUsageCache, readUsageCache } = usageCacheService;

  const codexAuthInvalidReconciler = buildCodexAuthInvalidReconciler({
    fs: deps.fs,
    path: deps.path,
    processObj: deps.processObj,
    aiHomeDir: deps.aiHomeDir,
    profilesDir: deps.profilesDir,
    getProfileDir: deps.getProfileDir,
    getToolConfigDir: deps.getToolConfigDir,
    accountStateService: deps.accountStateService,
    accountArtifactHooks: deps.accountArtifactHooks,
    refreshCodexAccessToken: deps.refreshCodexAccessToken,
    fetchWithTimeout: deps.fetchWithTimeout
  });

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
    usageSourceAgyCodeAssist: deps.usageSourceAgyCodeAssist,
    getProfileDir: deps.getProfileDir,
    getToolConfigDir: deps.getToolConfigDir,
    getAccountStateIndex: deps.getAccountStateIndex,
    accountStateService: deps.accountStateService,
    writeUsageCache,
    readUsageCache,
    accountArtifactHooks: deps.accountArtifactHooks,
    refreshAgyAccessToken: deps.refreshAgyAccessToken,
    fetchWithTimeout: deps.fetchWithTimeout,
    codexAuthInvalidReconciler
  });
  const {
    ensureUsageSnapshot,
    ensureUsageSnapshotAsync,
    buildAgyUsagePreflight,
    getClaudeUsageAuthForSandbox,
    getLastUsageProbeError,
    getLastUsageProbeState
  } = usageSnapshotService;

  const usageAccountRuntimeService = buildUsageAccountRuntimeService({
    path: deps.path,
    fs: deps.fs,
    profilesDir: deps.profilesDir,
    cliConfigs: deps.cliConfigs,
    createUsageScheduler: deps.createUsageScheduler,
    getAccountStateIndex: deps.getAccountStateIndex,
    accountStateService: deps.accountStateService,
    accountQueryService: deps.accountQueryService,
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
    getAccountQuotaState,
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
    buildAgyUsagePreflight,
    getClaudeUsageAuthForSandbox,
    getLastUsageProbeError,
    checkStatus: deps.checkStatus,
    getProfileDir: deps.getProfileDir,
    filterExistingAccountIds,
    getAccountStateIndex: deps.getAccountStateIndex,
    getToolAccountIds,
    getDefaultParallelism: deps.getDefaultParallelism,
    accountStateService: deps.accountStateService,
    getAccountQuotaState,
    getMinRemainingPctFromCache,
    codexAuthInvalidReconciler
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
    codexAuthInvalidReconciler,
    ensureUsageSnapshot,
    ensureUsageSnapshotAsync,
    buildAgyUsagePreflight,
    getClaudeUsageAuthForSandbox,
    getLastUsageProbeError,
    getLastUsageProbeState,
    extractActiveEnv,
    findEnvSandbox,
    getAccountQuotaState,
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
