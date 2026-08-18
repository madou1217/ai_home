'use strict';
const { createCodexLaunchSupport } = require('./codex-launch-support');

const { createPersistentLaunchWrapper } = require('./persistent-launch');

const { runSshMcpServerLoop } = require('./ssh-mcp-loop');

const {
  fetchSshClipAgentImage: defaultFetchSshClipAgentImage
} = require('../ssh-clipboard/clip-agent-client');
const createPtyRuntimeLaunchDomain = require('./pty-runtime-launch');
const createPtyRuntimeSpawnDomain = require('./pty-runtime-spawn');
const createPtyRuntimeRunDomain = require('./pty-runtime-run');
function createPtyRuntime(options = {}) {
  const {
    path,
    fs,
    processObj,
    pty,
    spawn,
    spawnSync,
    execSync,
    resolveCliPath,
    readServerConfig,
    serverDaemon,
    buildPtyLaunch,
    resolveWindowsBatchLaunch,
    resolveWindowsNodeShimLaunch,
    shouldEnableShellDrawer,
    isShellDrawerToggleSequence,
    resolveShellDrawerLaunch,
    getShellDrawerPtyRows,
    getShellDrawerTotalHeight,
    readUsageConfig,
    cliConfigs,
    aiHomeDir,
    hostHomeDir,
    getAccountRuntimeDir,
    getGatewayRuntimeDir,
    getLoginRuntimeDir,
    getProfileDir,
    askYesNo,
    stripAnsi,
    ensureSessionStoreLinks,
    ensureUsageSnapshot,
    ensureUsageSnapshotAsync,
    readUsageCache,
    getLastUsageProbeError,
    getLastUsageProbeState,
    getUsageRemainingPercentValues,
    getNextAvailableId,
    getAccountStateIndex,
    accountStateService,
    checkStatus,
    markActiveAccount,
    ensureAccountUsageRefreshScheduler,
    refreshIndexedStateForAccount,
    accountArtifactHooks,
    DatabaseSync,
    fetchSshClipAgentImage = defaultFetchSshClipAgentImage
  } = options;
  const shared = { lastRuntimeEnv: {} };
  const codexLaunchSupport = createCodexLaunchSupport({
    fs,
    path,
    hostHomeDir,
    aiHomeDir,
    getProfileDir,
    DatabaseSync,
    accountArtifactHooks
  });
  const persistentWrapper = createPersistentLaunchWrapper({
    fs,
    path,
    processObj,
    spawnSync,
    aiHomeDir,
    hostHomeDir,
    resolveCliPath,
    askYesNo,
    resolveWindowsNodeShimLaunch
  });
  const deps = {
    path,
    fs,
    processObj,
    pty,
    spawn,
    spawnSync,
    execSync,
    resolveCliPath,
    readServerConfig,
    serverDaemon,
    buildPtyLaunch,
    resolveWindowsBatchLaunch,
    resolveWindowsNodeShimLaunch,
    shouldEnableShellDrawer,
    isShellDrawerToggleSequence,
    resolveShellDrawerLaunch,
    getShellDrawerPtyRows,
    getShellDrawerTotalHeight,
    readUsageConfig,
    cliConfigs,
    aiHomeDir,
    hostHomeDir,
    getAccountRuntimeDir,
    getGatewayRuntimeDir,
    getLoginRuntimeDir,
    getProfileDir,
    askYesNo,
    stripAnsi,
    ensureSessionStoreLinks,
    ensureUsageSnapshot,
    ensureUsageSnapshotAsync,
    readUsageCache,
    getLastUsageProbeError,
    getLastUsageProbeState,
    getUsageRemainingPercentValues,
    getNextAvailableId,
    getAccountStateIndex,
    accountStateService,
    checkStatus,
    markActiveAccount,
    ensureAccountUsageRefreshScheduler,
    refreshIndexedStateForAccount,
    accountArtifactHooks,
    DatabaseSync,
    fetchSshClipAgentImage,
  };
  const launch = createPtyRuntimeLaunchDomain(deps, { codexLaunchSupport });
  const spawnDomain = createPtyRuntimeSpawnDomain(deps, launch, { shared, codexLaunchSupport, persistentWrapper });
  const run = createPtyRuntimeRunDomain(deps, launch, spawnDomain, { shared, codexLaunchSupport, persistentWrapper });

  return { runCliPtyTracked: run.runCliPtyTracked };
}

module.exports = {
  createPtyRuntime,
  runSshMcpServerLoop
};
