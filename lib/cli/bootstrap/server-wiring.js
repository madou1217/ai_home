'use strict';

const { createServerDaemonService } = require('../services/server/daemon');
const { createServerDaemonAdapter } = require('../services/server/daemon-adapter');
const { createServerLocalRuntimeService } = require('../services/server/local-runtime');
const { syncCodexAccountsToServer: syncCodexAccountsToServerService } = require('../services/server/sync-codex');
const { createCodexDesktopHookService } = require('../../server/codex-desktop-hook');

function createServerWiring(deps = {}, factories = {}) {
  const buildDaemonService = factories.createServerDaemonService || createServerDaemonService;
  const buildDaemonAdapter = factories.createServerDaemonAdapter || createServerDaemonAdapter;
  const buildLocalRuntimeService = factories.createServerLocalRuntimeService || createServerLocalRuntimeService;
  const syncCodexService = factories.syncCodexAccountsToServerService || syncCodexAccountsToServerService;
  const buildCodexDesktopHookService = factories.createCodexDesktopHookService || createCodexDesktopHookService;
  let foregroundCodexDesktopHookService = null;

  const prepareBackgroundStart = deps.enableCodexDesktopAppHook === true
    ? () => {
      if (!foregroundCodexDesktopHookService) {
        foregroundCodexDesktopHookService = buildCodexDesktopHookService({
          fs: deps.fs,
          path: deps.path,
          processObj: deps.processObj,
          spawnSync: deps.spawnSync,
          aiHomeDir: deps.aiHomeDir,
          hostHomeDir: deps.hostHomeDir,
          nodeExecPath: deps.processObj && deps.processObj.execPath
            ? deps.processObj.execPath
            : process.execPath
        });
      }
      return foregroundCodexDesktopHookService.activate();
    }
    : null;

  const serverDaemonService = buildDaemonService({
    fs: deps.fs,
    path: deps.path,
    spawn: deps.spawn,
    spawnSync: deps.spawnSync,
    fetchImpl: deps.fetchImpl,
    processObj: deps.processObj,
    ensureDir: deps.ensureDir,
    parseServeArgs: deps.parseServerServeArgs,
    readServerConfig: deps.readServerConfig,
    buildServerArgsFromConfig: deps.buildServerArgsFromConfig,
    aiHomeDir: deps.aiHomeDir,
    hostHomeDir: deps.hostHomeDir,
    pidFile: deps.pidFile,
    logFile: deps.logFile,
    launchdLabel: deps.launchdLabel,
    launchdPlist: deps.launchdPlist,
    entryFilePath: deps.entryFilePath,
    prepareBackgroundStart
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
      fetchImpl: deps.fetchImpl,
      processObj: deps.processObj,
      spawn: deps.spawn,
      spawnSync: deps.spawnSync,
      path: deps.path,
      resolveCliPath: deps.resolveCliPath,
      logFile: deps.logFile,
      entryFilePath: deps.entryFilePath,
      nodeExecPath: deps.processObj && deps.processObj.execPath ? deps.processObj.execPath : process.execPath,
      getToolConfigDir: deps.getToolConfigDir,
      getProfileDir: deps.getProfileDir,
      checkStatus: deps.checkStatus,
      getLastUsageProbeError: deps.getLastUsageProbeError,
      getLastUsageProbeState: deps.getLastUsageProbeState,
      ensureUsageSnapshotAsync: deps.ensureUsageSnapshotAsync,
      codexAuthInvalidReconciler: deps.codexAuthInvalidReconciler,
      ensureSessionStoreLinks: deps.ensureSessionStoreLinks,
      syncGlobalConfigToHost: deps.syncGlobalConfigToHost,
      accountArtifactHooks: deps.accountArtifactHooks,
      applyAihFrpConfig: deps.applyAihFrpConfig,
      discoverFrpcConfigPath: deps.discoverFrpcConfigPath,
      reconcileAihFrpConfig: deps.reconcileAihFrpConfig,
      removeAihFrpConfig: deps.removeAihFrpConfig,
      connectFabricBroker: deps.connectFabricBroker,
      enableCodexDesktopAppHook: deps.enableCodexDesktopAppHook === true,
      enableCodexCliHook: deps.enableCodexCliHook === true
    },
    syncCodexAccountsToServerService: syncCodexService,
    syncCodexDeps: {
      fetchImpl: deps.fetchImpl,
      fs: deps.fs,
      aiHomeDir: deps.aiHomeDir
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
