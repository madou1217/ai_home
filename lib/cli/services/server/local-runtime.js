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
    // Go server owns its own usage/state refresh. Running the old Node preludes
    // here would start duplicate timers beside the Go process; do not keep them
    // as a "compatibility" layer, because that reintroduces a second writer.
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
