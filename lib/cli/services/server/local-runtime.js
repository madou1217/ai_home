'use strict';

function createServerLocalRuntimeService(options = {}) {
  const {
    usageIndexBgRefreshLimit,
    ensureAccountUsageRefreshScheduler,
    refreshAccountStateIndexForProvider,
    startLocalServerModule,
    startLocalServerDeps,
    syncCodexAccountsToServerService,
    syncCodexDeps
  } = options;

  async function startLocalServer(runtimeOptions) {
    ensureAccountUsageRefreshScheduler();
    refreshAccountStateIndexForProvider('codex', { refreshSnapshot: false, limit: usageIndexBgRefreshLimit });
    refreshAccountStateIndexForProvider('gemini', { refreshSnapshot: false, limit: usageIndexBgRefreshLimit });
    return startLocalServerModule(runtimeOptions, startLocalServerDeps);
  }

  async function syncCodexAccountsToServer(syncOptions) {
    return syncCodexAccountsToServerService(syncOptions, syncCodexDeps);
  }

  return {
    startLocalServer,
    syncCodexAccountsToServer
  };
}

module.exports = {
  createServerLocalRuntimeService
};
