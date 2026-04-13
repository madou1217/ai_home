'use strict';

async function runServerEntry(args, deps) {
  const {
    fs,
    fetchImpl,
    http,
    processObj,
    spawn,
    aiHomeDir,
    logFile,
    entryFilePath,
    getToolAccountIds,
    getToolConfigDir,
    getProfileDir,
    checkStatus,
    getLastUsageProbeError,
    getLastUsageProbeState,
    ensureUsageSnapshotAsync,
    ensureSessionStoreLinks,
    syncCodexAccountsToServer,
    startLocalServerModule,
    runServerCommand,
    showServerUsage,
    serverDaemon,
    parseServerSyncArgs,
    parseServerServeArgs,
    parseServerEnvArgs
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
    processObj,
    spawn,
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
    ensureSessionStoreLinks
  });

  return runServerCommand(args, {
    showServerUsage,
    serverDaemon,
    parseServerSyncArgs,
    parseServerServeArgs,
    parseServerEnvArgs,
    startLocalServer,
    syncCodexAccountsToServer: syncCodex
  });
}

module.exports = {
  runServerEntry
};
