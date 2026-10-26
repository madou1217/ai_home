'use strict';

const { createWindowsRestartElevation } = require('../cli/services/server/windows-restart-elevation');

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
    writeServerConfig,
    runServerProfileCommand,
    formatServerProfileResult
  } = deps;

  const syncCodex = (opts) => syncCodexAccountsToServer(opts, {
    fs,
    aiHomeDir,
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
    runServerProfileCommand: (action, commandArgs) => runServerProfileCommand(action, commandArgs, {
      fs,
      aiHomeDir
    }),
    formatServerProfileResult,
    processObj,
    elevateServerRestart: deps.elevateServerRestart || createWindowsRestartElevation({
      processObj,
      spawnSync,
      aiHomeDir,
      entryFilePath: processObj && Array.isArray(processObj.argv) && processObj.argv[1]
        ? processObj.argv[1]
        : entryFilePath
    }),
    startLocalServer,
    syncCodexAccountsToServer: syncCodex
  });
}

module.exports = {
  runServerEntry
};
