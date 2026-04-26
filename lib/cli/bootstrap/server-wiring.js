'use strict';

const { createServerDaemonService } = require('../services/server/daemon');
const { createServerDaemonAdapter } = require('../services/server/daemon-adapter');
const { createServerLocalRuntimeService } = require('../services/server/local-runtime');
const { syncCodexAccountsToServer: syncCodexAccountsToServerService } = require('../services/server/sync-codex');

function createServerWiring(deps = {}, factories = {}) {
  const buildDaemonService = factories.createServerDaemonService || createServerDaemonService;
  const buildDaemonAdapter = factories.createServerDaemonAdapter || createServerDaemonAdapter;
  const buildLocalRuntimeService = factories.createServerLocalRuntimeService || createServerLocalRuntimeService;
  const syncCodexService = factories.syncCodexAccountsToServerService || syncCodexAccountsToServerService;

  const serverDaemonService = buildDaemonService({
    fs: deps.fs,
    path: deps.path,
    spawn: deps.spawn,
    spawnSync: deps.spawnSync,
    fetchImpl: deps.fetchImpl,
    processObj: deps.processObj,
    ensureDir: deps.ensureDir,
    parseServeArgs: deps.parseServerServeArgs,
    aiHomeDir: deps.aiHomeDir,
    pidFile: deps.pidFile,
    logFile: deps.logFile,
    launchdLabel: deps.launchdLabel,
    launchdPlist: deps.launchdPlist,
    entryFilePath: deps.entryFilePath
  });
  const serverDaemon = buildDaemonAdapter(serverDaemonService);

  const serverLocalRuntimeService = buildLocalRuntimeService({
    usageIndexBgRefreshLimit: deps.usageIndexBgRefreshLimit,
    ensureAccountUsageRefreshScheduler: deps.ensureAccountUsageRefreshScheduler,
    refreshAccountStateIndexForProvider: deps.refreshAccountStateIndexForProvider,
    startLocalServerModule: deps.startLocalServerModule,
    startLocalServerDeps: {
      http: deps.http,
      fs: deps.fs,
      aiHomeDir: deps.aiHomeDir,
      hostHomeDir: deps.hostHomeDir,
      processObj: deps.processObj,
      spawn: deps.spawn,
      spawnSync: deps.spawnSync,
      path: deps.path,
      resolveCliPath: deps.resolveCliPath,
      logFile: deps.logFile,
      entryFilePath: deps.entryFilePath,
      nodeExecPath: deps.processObj && deps.processObj.execPath ? deps.processObj.execPath : process.execPath,
      getToolAccountIds: deps.getToolAccountIds,
      getToolConfigDir: deps.getToolConfigDir,
      getProfileDir: deps.getProfileDir,
      checkStatus: deps.checkStatus,
      getLastUsageProbeError: deps.getLastUsageProbeError,
      getLastUsageProbeState: deps.getLastUsageProbeState,
      ensureUsageSnapshotAsync: deps.ensureUsageSnapshotAsync,
      ensureSessionStoreLinks: deps.ensureSessionStoreLinks,
      enableCodexDesktopAppHook: deps.enableCodexDesktopAppHook === true,
      enableCodexCliHook: deps.enableCodexCliHook === true
    },
    syncCodexAccountsToServerService: syncCodexService,
    syncCodexDeps: {
      fetchImpl: deps.fetchImpl,
      path: deps.path,
      getToolAccountIds: deps.getToolAccountIds,
      getToolConfigDir: deps.getToolConfigDir,
      fs: deps.fs
    }
  });

  const { startLocalServer, syncCodexAccountsToServer } = serverLocalRuntimeService;

  return {
    serverDaemon,
    startLocalServer,
    syncCodexAccountsToServer
  };
}

module.exports = {
  createServerWiring
};
