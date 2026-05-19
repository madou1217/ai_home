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
    readServerConfig: deps.readServerConfig,
    serverDaemon: deps.serverDaemon,
    buildPtyLaunch: deps.buildPtyLaunch,
    resolveWindowsBatchLaunch: deps.resolveWindowsBatchLaunch,
    shouldEnableShellDrawer: deps.shouldEnableShellDrawer,
    isShellDrawerToggleSequence: deps.isShellDrawerToggleSequence,
    resolveShellDrawerLaunch: deps.resolveShellDrawerLaunch,
    getShellDrawerPtyRows: deps.getShellDrawerPtyRows,
    getShellDrawerTotalHeight: deps.getShellDrawerTotalHeight,
    readUsageConfig: deps.readUsageConfig,
    cliConfigs: deps.cliConfigs,
    aiHomeDir: deps.aiHomeDir,
    hostHomeDir: deps.hostHomeDir,
    getProfileDir: deps.getProfileDir,
    askYesNo: deps.askYesNo,
    stripAnsi: deps.stripAnsi,
    ensureSessionStoreLinks: deps.ensureSessionStoreLinks,
    ensureUsageSnapshot: deps.ensureUsageSnapshot,
    ensureUsageSnapshotAsync: deps.ensureUsageSnapshotAsync,
    readUsageCache: deps.readUsageCache,
    getLastUsageProbeError: deps.getLastUsageProbeError,
    getLastUsageProbeState: deps.getLastUsageProbeState,
    getUsageRemainingPercentValues: deps.getUsageRemainingPercentValues,
    getNextAvailableId: deps.getNextAvailableId,
    getAccountStateIndex: deps.getAccountStateIndex,
    accountStateService: deps.accountStateService,
    checkStatus: deps.checkStatus,
    markActiveAccount: deps.markActiveAccount,
    ensureAccountUsageRefreshScheduler: deps.ensureAccountUsageRefreshScheduler,
    refreshIndexedStateForAccount: deps.refreshIndexedStateForAccount
  };
}

module.exports = {
  createPtyRuntimeDeps
};
