'use strict';

async function runServerEntry(args, deps) {
  const {
    fs,
    fetchImpl,
    http,
    processObj,
    aiHomeDir,
    logFile,
    getToolAccountIds,
    getToolConfigDir,
    getProfileDir,
    checkStatus,
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
    logFile,
    getToolAccountIds,
    getToolConfigDir,
    getProfileDir,
    checkStatus
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
