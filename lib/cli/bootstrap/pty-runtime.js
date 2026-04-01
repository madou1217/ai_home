'use strict';

function createPtyRuntimeDeps(deps = {}) {
  return {
    path: deps.path,
    fs: deps.fs,
    processObj: deps.processObj,
    pty: deps.pty,
    spawn: deps.spawn,
    execSync: deps.execSync,
    resolveCliPath: deps.resolveCliPath,
    buildPtyLaunch: deps.buildPtyLaunch,
    resolveWindowsBatchLaunch: deps.resolveWindowsBatchLaunch,
    readUsageConfig: deps.readUsageConfig,
    cliConfigs: deps.cliConfigs,
    aiHomeDir: deps.aiHomeDir,
    getProfileDir: deps.getProfileDir,
    askYesNo: deps.askYesNo,
    stripAnsi: deps.stripAnsi,
    ensureSessionStoreLinks: deps.ensureSessionStoreLinks,
    ensureUsageSnapshot: deps.ensureUsageSnapshot,
    ensureUsageSnapshotAsync: deps.ensureUsageSnapshotAsync,
    readUsageCache: deps.readUsageCache,
    getUsageRemainingPercentValues: deps.getUsageRemainingPercentValues,
    getNextAvailableId: deps.getNextAvailableId,
    markActiveAccount: deps.markActiveAccount,
    ensureAccountUsageRefreshScheduler: deps.ensureAccountUsageRefreshScheduler,
    refreshIndexedStateForAccount: deps.refreshIndexedStateForAccount
  };
}

module.exports = {
  createPtyRuntimeDeps
};
