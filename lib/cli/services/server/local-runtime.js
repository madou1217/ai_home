'use strict';

const { timeStep } = require('../../../server/startup-timeline');

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
    // 这几步发生在网关监听之前、又在 server 内部计时之外，单独计时后交给启动时间线汇总。
    const preludeSteps = [];
    timeStep(preludeSteps, 'usageRefreshScheduler', () => ensureAccountUsageRefreshScheduler());
    timeStep(preludeSteps, 'stateIndex:codex', () => refreshAccountStateIndexForProvider('codex', { refreshSnapshot: false, limit: usageIndexBgRefreshLimit }));
    timeStep(preludeSteps, 'stateIndex:gemini', () => refreshAccountStateIndexForProvider('gemini', { refreshSnapshot: false, limit: usageIndexBgRefreshLimit }));
    return startLocalServerModule({ ...runtimeOptions, startupPreludeSteps: preludeSteps }, startLocalServerDeps);
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
