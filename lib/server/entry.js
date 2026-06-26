'use strict';

async function runServerEntry(args, deps) {
  const {
    fs,
    fetchImpl,
    http,
    path,
    processObj,
    spawn,
    spawnSync,
    aiHomeDir,
    hostHomeDir,
    logFile,
    entryFilePath,
    getToolAccountIds,
    getToolConfigDir,
    getProfileDir,
    checkStatus,
    getLastUsageProbeError,
    getLastUsageProbeState,
    ensureUsageSnapshotAsync,
    codexAuthInvalidReconciler,
    ensureSessionStoreLinks,
    syncGlobalConfigToHost,
    accountArtifactHooks,
    syncCodexAccountsToServer,
    startLocalServerModule,
    runServerCommand,
    showServerUsage,
    serverDaemon,
    parseServerSyncArgs,
    parseServerServeArgs,
    parseServerEnvArgs,
    readServerConfig,
    writeServerConfig
  } = deps;

  const syncCodex = (opts) => syncCodexAccountsToServer(opts, {
    fs,
    getToolAccountIds,
    getToolConfigDir,
    fetchImpl
  });

  const startLocalServer = (opts) => startLocalServerModule(opts, {
    http,
    fs,
    aiHomeDir,
    hostHomeDir,
    fetchImpl,
    processObj,
    spawn,
    spawnSync,
    path,
    resolveCliPath: deps.resolveCliPath,
    logFile,
    entryFilePath,
    nodeExecPath: processObj && processObj.execPath ? processObj.execPath : process.execPath,
    getToolAccountIds,
    getToolConfigDir,
    getProfileDir,
    checkStatus,
    getLastUsageProbeError,
    getLastUsageProbeState,
    ensureUsageSnapshotAsync,
    codexAuthInvalidReconciler,
    ensureSessionStoreLinks,
    syncGlobalConfigToHost,
    accountArtifactHooks,
    enableCodexDesktopAppHook: deps.enableCodexDesktopAppHook === true,
    enableCodexCliHook: deps.enableCodexCliHook === true
  });

  return runServerCommand(args, {
    showServerUsage,
    serverDaemon,
    parseServerSyncArgs,
    parseServerServeArgs,
    parseServerEnvArgs,
    readServerConfig,
    writeServerConfig,
    startLocalServer,
    syncCodexAccountsToServer: syncCodex
  });
}

module.exports = {
  runServerEntry
};
