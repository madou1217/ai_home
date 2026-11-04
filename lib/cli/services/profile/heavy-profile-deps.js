'use strict';

// 列表补算需要的"贵"服务装配（凭据 / 用量 / 索引刷新）。
//
// 单独成模块的原因：这些 require 一旦发生就是几百毫秒起步，主线程的**第一帧**
// 绝不能碰；它们要么在 worker 里加载，要么等第一帧之后的兜底补算才懒加载。

const {
  USAGE_CACHE_MAX_AGE_MS,
  USAGE_INDEX_STALE_REFRESH_MS,
  USAGE_INDEX_BG_REFRESH_LIMIT,
  USAGE_SNAPSHOT_SCHEMA_VERSION,
  USAGE_SOURCE_GEMINI,
  USAGE_SOURCE_CODEX,
  USAGE_SOURCE_CLAUDE_OAUTH,
  USAGE_SOURCE_CLAUDE_AUTH_TOKEN,
  USAGE_SOURCE_AGY_CODE_ASSIST,
  USAGE_SOURCE_KIMI
} = require('../../config/constants');

function createHeavyProfileDeps(options = {}) {
  const { fs, path, processObj, aiHomeDir, getProfileDir, cliConfigs } = options;
  const { createAccountStateRegistryService } = require('../account/state-registry');
  const { createAccountStatusChecker } = require('../account/status');
  const { createUsageCacheService } = require('../usage/cache');
  const { createUsageAccountRuntimeService } = require('../usage/account-runtime');
  const { createUsagePresenterService } = require('../usage/presenter');
  const { getDefaultParallelism } = require('../../../runtime/parallelism');
  const { readAccountCredentials } = require('../../../server/account-credential-store');

  const registry = createAccountStateRegistryService({
    fs,
    aiHomeDir,
    getProfileDir,
    stateIndexClient: null
  });
  const getAccountStateIndex = registry.getAccountStateIndex;
  const checkStatus = createAccountStatusChecker({
    fs,
    path,
    BufferImpl: Buffer,
    cliConfigs,
    aiHomeDir
  });

  const usageCacheService = createUsageCacheService({
    fs,
    aiHomeDir,
    usageSnapshotSchemaVersion: USAGE_SNAPSHOT_SCHEMA_VERSION,
    usageSourceGemini: USAGE_SOURCE_GEMINI,
    usageSourceCodex: USAGE_SOURCE_CODEX,
    usageSourceClaudeOauth: USAGE_SOURCE_CLAUDE_OAUTH,
    usageSourceClaudeAuthToken: USAGE_SOURCE_CLAUDE_AUTH_TOKEN,
    usageSourceAgyCodeAssist: USAGE_SOURCE_AGY_CODE_ASSIST,
    usageSourceKimiOauth: USAGE_SOURCE_KIMI
  });
  const { readUsageCache } = usageCacheService;

  const accountStateService = registry.getAccountStateService();
  const accountQueryService = registry.getAccountQueryService();

  const accountRuntime = createUsageAccountRuntimeService({
    fs,
    aiHomeDir,
    cliConfigs,
    getAccountStateIndex,
    accountStateService,
    accountQueryService,
    checkStatus,
    readUsageCache,
    usageIndexStaleRefreshMs: USAGE_INDEX_STALE_REFRESH_MS,
    usageIndexBgRefreshLimit: USAGE_INDEX_BG_REFRESH_LIMIT,
    // 列表从不按需抓取用量快照（refreshSnapshot: false），这里只是让服务可构造。
    ensureUsageSnapshot: (cliName, accountRef, cache) => cache,
    createUsageScheduler: null
  });

  const presenter = createUsagePresenterService({
    processObj,
    fs,
    aiHomeDir,
    usageCacheMaxAgeMs: USAGE_CACHE_MAX_AGE_MS,
    readUsageCache,
    ensureUsageSnapshot: () => null,
    ensureUsageSnapshotAsync: async () => null,
    buildAgyUsagePreflight: null,
    getClaudeUsageAuthForSandbox: null,
    getLastUsageProbeError: () => '',
    checkStatus,
    filterExistingAccountIds: accountRuntime.filterExistingAccountIds,
    getAccountStateIndex,
    getToolAccountIds: accountRuntime.getToolAccountIds,
    getDefaultParallelism,
    accountStateService,
    getAccountQuotaState: accountRuntime.getAccountQuotaState,
    getMinRemainingPctFromCache: accountRuntime.getMinRemainingPctFromCache,
    codexAuthInvalidReconciler: null
  });

  return {
    fs,
    aiHomeDir,
    getAccountStateIndex,
    checkStatus,
    readAccountCredentials,
    refreshIndexedStateForAccount: accountRuntime.refreshIndexedStateForAccount,
    formatUsageLabel: presenter.formatUsageLabel,
    formatAccountPlanBadge: presenter.formatAccountPlanBadge
  };
}

module.exports = {
  createHeavyProfileDeps
};
