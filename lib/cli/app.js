#!/usr/bin/env node

const path = require('path');
const fs = require('fs');
const fse = require('fs-extra');
const os = require('os');
const crypto = require('crypto');
const readline = require('readline-sync');
const { execSync, spawnSync, spawn } = require('child_process');
const http = require('http');
const {
  USAGE_CACHE_MAX_AGE_MS,
  USAGE_REFRESH_STALE_MS,
  USAGE_INDEX_STALE_REFRESH_MS,
  USAGE_INDEX_BG_REFRESH_LIMIT,
  USAGE_SNAPSHOT_SCHEMA_VERSION,
  USAGE_SOURCE_GEMINI,
  USAGE_SOURCE_CODEX,
  USAGE_SOURCE_CLAUDE_OAUTH,
  USAGE_SOURCE_CLAUDE_AUTH_TOKEN,
  LIST_PAGE_SIZE,
  EXPORT_MAGIC,
  EXPORT_VERSION,
  AGE_SSH_KEY_TYPES,
  AIH_SERVER_LAUNCHD_LABEL
} = require('./config/constants');
const {
  commandExists: runtimeCommandExists,
  resolveCliPath
} = require('../runtime/platform-runtime');
const { getDefaultParallelism } = require('../runtime/parallelism');
const {
  loadPermissionPolicy,
  savePermissionPolicy,
  shouldUseDangerFullAccess
} = require('../runtime/permission-policy');
const { createUsageScheduler } = require('../usage/scheduler');
const { readConfig: readUsageConfig } = require('../usage/config-store');
const {
  parseServerSyncArgs,
  parseServerServeArgs,
  parseServerEnvArgs
} = require('./services/server/args');
const { showServerUsage } = require('./services/server/usage');
const { runGlobalAccountImport } = require('./services/ai-cli/account-import-orchestrator');
const { AI_CLI_CONFIGS: CLI_CONFIGS } = require('./services/ai-cli/provider-registry');
const { runCliRootRouter } = require('./commands/root/router');
const { createRootDispatchWiring } = require('./bootstrap/root-dispatch');
const { createUpdateWiring } = require('./bootstrap/update-wiring');
const { createPtyRuntimeDeps } = require('./bootstrap/pty-runtime');
const { createServerWiring } = require('./bootstrap/server-wiring');
const { createUsageWiring } = require('./bootstrap/usage-wiring');
const { createAccountCoreWiring, createAccountSelectionWiring, createAccountCleanupWiring } = require('./bootstrap/account-wiring');
const { runDevCommand } = require('./commands/dev/router');
const { runBackupCommand } = require('./commands/backup/router');
const { createPtyRuntime } = require('./services/pty/runtime');
const { runAiCliCommandRouter } = require('./commands/ai-cli/router');
const { startLocalServer: startLocalServerModule } = require('../server/server');
const { runServerEntry } = require('../server/entry');
const { runServerCommand } = require('../server/command-handler');
const { readServerConfig, writeServerConfig } = require('../server/server-config-store');
const { deleteSelfRelayAccounts } = require('../account/self-relay-account');
const {
  createSessionStoreWiring,
  createProfileAccountWiring,
  createProfileListWiring
} = require('./bootstrap/profile-wiring');
const {
  createBackupRestoreWiring,
  createBackupCryptoWiring,
  createBackupHelperWiring,
  createBackupExportWiring
} = require('./bootstrap/backup-wiring');
const { createImportWiring } = require('./bootstrap/import-wiring');
const {
  createCodexImportWiring,
  createCodexPolicyWiring,
  createCliHelpWiring,
  createDesktopClientRestartWiring
} = require('./bootstrap/cli-feature-wiring');
const {
  createHostConfigSyncWiring,
  createStateIndexClientWiring,
  createInteractionWiring
} = require('./bootstrap/runtime-support-wiring');
const { createStartupWiring } = require('./bootstrap/startup-wiring');

function isEnvEnabled(name, defaultValue) {
  const raw = String(process.env[name] || '').trim().toLowerCase();
  if (!raw) return defaultValue;
  return !['0', 'false', 'no', 'off'].includes(raw);
}

const {
  hostHomeDir: HOST_HOME_DIR,
  aiHomeDir: AI_HOME_DIR,
  profilesDir: PROFILES_DIR,
  serverPidFile: AIH_SERVER_PID_FILE,
  serverLogFile: AIH_SERVER_LOG_FILE,
  serverLaunchdPlist: AIH_SERVER_LAUNCHD_PLIST,
  ensureDir,
  getProfileDir
} = createStartupWiring({
  path,
  fs,
  env: process.env,
  platform: process.platform,
  os,
  launchdLabel: AIH_SERVER_LAUNCHD_LABEL
});

const syncGlobalConfigToHost = createHostConfigSyncWiring({
  fs,
  fse,
  ensureDir,
  getProfileDir,
  hostHomeDir: HOST_HOME_DIR,
  cliConfigs: CLI_CONFIGS,
  readServerConfig: () => readServerConfig({ fs, aiHomeDir: AI_HOME_DIR })
});

const stateIndexClient = createStateIndexClientWiring({
  fetchImpl: fetch,
  env: process.env,
  abortSignalFactory: (timeoutMs) => AbortSignal.timeout(timeoutMs)
});

const {
  getAccountStateIndex,
  getAccountStateService,
  getAccountQueryService,
  lastActiveAccountByCli,
  markActiveAccount,
  checkStatus
} = createAccountCoreWiring({
  fs,
  path,
  aiHomeDir: AI_HOME_DIR,
  getProfileDir,
  stateIndexClient,
  BufferImpl: Buffer,
  cliConfigs: CLI_CONFIGS
});
const accountStateService = getAccountStateService();
const accountQueryService = getAccountQueryService();

const {
  askYesNo,
  stripAnsi
} = createInteractionWiring({ readLine: readline });

function setAccountOperationalStatus(cliName, accountId, status) {
  const normalizedStatus = String(status || '').trim().toLowerCase();
  if (!cliName || !/^\d+$/.test(String(accountId || ''))) return false;
  if (normalizedStatus !== 'up' && normalizedStatus !== 'down') return false;
  const profileDir = getProfileDir(cliName, accountId);
  const currentState = accountStateService.getAccountState(cliName, accountId) || {};
  const liveStatus = checkStatus(cliName, profileDir) || {};
  return accountStateService.setOperationalStatus(cliName, accountId, normalizedStatus, {
    configured: typeof currentState.configured === 'boolean' ? currentState.configured : Boolean(liveStatus.configured),
    apiKeyMode: Boolean(currentState.api_key_mode),
    authMode: String(currentState.auth_mode || '').trim(),
    displayName: String(
      currentState.display_name
      || (liveStatus.accountName && liveStatus.accountName !== 'Unknown' ? liveStatus.accountName : '')
      || `${cliName}-${accountId}`
    ).trim()
  });
}

const { runUpdateCommand } = createUpdateWiring({
  fs,
  path,
  fetchImpl: fetch,
  spawnSync,
  processObj: process,
  log: console.log,
  error: console.error
});
const {
  getToolConfigDir,
  ensureSessionStoreLinks,
  ensureAllSessionStoreLinks
} = createSessionStoreWiring({
  fs,
  fse,
  path,
  processObj: process,
  profilesDir: PROFILES_DIR,
  hostHomeDir: HOST_HOME_DIR,
  cliConfigs: CLI_CONFIGS,
  getProfileDir,
  ensureDir
});

const {
  printRestoreDetails,
  restoreProfilesFromExtractedBackup
} = createBackupRestoreWiring({
  fs,
  path,
  fse,
  ensureDir,
  profilesDir: PROFILES_DIR,
  checkStatus
});

const {
  getUsageCachePath,
  readUsageCache,
  ensureUsageSnapshot,
  ensureUsageSnapshotAsync,
  getLastUsageProbeError,
  getLastUsageProbeState,
  extractActiveEnv,
  findEnvSandbox,
  getAccountQuotaState,
  getUsageRemainingPercentValues,
  refreshIndexedStateForAccount,
  refreshAccountStateIndexForProvider,
  ensureAccountUsageRefreshScheduler,
  getToolAccountIds,
  formatUsageLabel,
  printUsageSnapshot,
  printUsageSnapshotAsync,
  buildUsageProbePayload,
  buildUsageProbePayloadAsync,
  printAllUsageSnapshots
} = createUsageWiring({
  fs,
  path,
  spawn,
  spawnSync,
  fetchImpl: fetch,
  processObj: process,
  resolveCliPath,
  getProfileDir,
  getToolConfigDir,
  profilesDir: PROFILES_DIR,
  cliConfigs: CLI_CONFIGS,
  createUsageScheduler,
  getAccountStateIndex,
  accountQueryService,
  accountStateService,
  stateIndexClient,
  lastActiveAccountByCli,
  checkStatus,
  getDefaultParallelism,
  usageSnapshotSchemaVersion: USAGE_SNAPSHOT_SCHEMA_VERSION,
  usageRefreshStaleMs: USAGE_REFRESH_STALE_MS,
  usageIndexStaleRefreshMs: USAGE_INDEX_STALE_REFRESH_MS,
  usageIndexBgRefreshLimit: USAGE_INDEX_BG_REFRESH_LIMIT,
  usageCacheMaxAgeMs: USAGE_CACHE_MAX_AGE_MS,
  usageSourceGemini: USAGE_SOURCE_GEMINI,
  usageSourceCodex: USAGE_SOURCE_CODEX,
  usageSourceClaudeOauth: USAGE_SOURCE_CLAUDE_OAUTH,
  usageSourceClaudeAuthToken: USAGE_SOURCE_CLAUDE_AUTH_TOKEN
});

const {
  parseCodexBulkImportArgs,
  importCodexTokensFromOutput
} = createCodexImportWiring({
  path,
  fs,
  crypto,
  profilesDir: PROFILES_DIR,
  getDefaultParallelism,
  getToolAccountIds,
  ensureDir,
  getProfileDir,
  getToolConfigDir
});

const {
  getSshKeys,
  getLikelyRsaSshPrivateKeys,
  hasAgeBinary,
  tryAutoInstallAge,
  getAgeCompatibleSshPublicKeys,
  getAgeCompatibleSshPrivateKeys,
  isAgeArmoredData,
  runAgeEncrypt,
  runAgeDecrypt,
  loadRsaPrivateKey,
  decryptSshRsaEnvelope,
  isPasswordArchiveFile,
  encryptTarWithPassword,
  decryptPasswordArchive,
  buildPasswordEnvelope,
  decryptPasswordEnvelope,
  serializeEnvelope,
  parseEnvelope,
  decryptLegacyEnvelope
} = createBackupCryptoWiring({
  fs,
  path,
  crypto,
  spawnSync,
  execSync,
  commandExists: runtimeCommandExists,
  askYesNo,
  processObj: process,
  hostHomeDir: HOST_HOME_DIR,
  exportMagic: EXPORT_MAGIC,
  exportVersion: EXPORT_VERSION,
  ageSshKeyTypes: AGE_SSH_KEY_TYPES
});

const {
  ensureAesSuffix,
  defaultExportName,
  parseExportArgs,
  parseImportArgs,
  renderStageProgress,
  expandSelectorsToPaths
} = createBackupHelperWiring({
  fs,
  path,
  processObj: process,
  aiHomeDir: AI_HOME_DIR,
  cliConfigs: CLI_CONFIGS
});

const {
  exportCliproxyapiCodexAuths,
  importCliproxyapiCodexAuths
} = createBackupExportWiring({
  fs,
  path,
  aiHomeDir: AI_HOME_DIR,
  hostHomeDir: HOST_HOME_DIR,
  BufferImpl: Buffer
});

const {
  runUnifiedImport
} = createImportWiring({
  fs,
  path,
  os,
  fse,
  execSync,
  spawnImpl: spawn,
  processObj: process,
  cryptoImpl: crypto,
  aiHomeDir: AI_HOME_DIR,
  cliConfigs: CLI_CONFIGS,
  runGlobalAccountImport,
  importCliproxyapiCodexAuths,
  parseCodexBulkImportArgs,
  importCodexTokensFromOutput
});

const {
  getNextId,
  createAccount
} = createProfileAccountWiring({
  fs,
  fse,
  path,
  profilesDir: PROFILES_DIR,
  hostHomeDir: HOST_HOME_DIR,
  cliConfigs: CLI_CONFIGS,
  ensureSessionStoreLinks,
  askYesNo,
  getProfileDir
});

const {
  getNextAvailableId
} = createAccountSelectionWiring({
  path,
  fs,
  profilesDir: PROFILES_DIR,
  getAccountStateIndex,
  accountStateService,
  accountQueryService,
  getProfileDir,
  getToolAccountIds,
  checkStatus,
  stateIndexClient,
  refreshIndexedStateForAccount,
  readServerConfig: () => readServerConfig({ fs, aiHomeDir: AI_HOME_DIR })
});

const {
  cleanupCodexAccounts,
  parseDeleteSelectorTokens,
  deleteAccountsForCli,
  deleteAllAccountsForCli
} = createAccountCleanupWiring({
  fs,
  path,
  hostHomeDir: HOST_HOME_DIR,
  profilesDir: PROFILES_DIR,
  getProfileDir,
  getAccountStateIndex,
  accountStateService,
  checkStatus,
  readUsageCache,
  ensureUsageSnapshotAsync,
  getLastUsageProbeError
});

const {
  showLsHelp,
  listProfiles,
  countProfiles
} = createProfileListWiring({
  fs,
  path,
  processObj: process,
  readline,
  profilesDir: PROFILES_DIR,
  cliConfigs: CLI_CONFIGS,
  listPageSize: LIST_PAGE_SIZE,
  getToolAccountIds,
  getAccountStateIndex,
  checkStatus,
  formatUsageLabel,
  refreshIndexedStateForAccount
});

try {
  if (fs.existsSync(PROFILES_DIR)) {
    deleteSelfRelayAccounts({
      fs,
      profilesDir: PROFILES_DIR,
      aiHomeDir: AI_HOME_DIR,
      getProfileDir,
      getToolConfigDir,
      checkStatus,
      accountStateIndex: getAccountStateIndex(),
      accountStateService,
      readServerConfig: () => readServerConfig({ fs, aiHomeDir: AI_HOME_DIR })
    });
  }
} catch (_error) {}

const {
  showCodexPolicy,
  setCodexPolicy
} = createCodexPolicyWiring({
  aiHomeDir: AI_HOME_DIR,
  loadPermissionPolicy,
  savePermissionPolicy,
  shouldUseDangerFullAccess
});

const {
  showHelp,
  showCliUsage
} = createCliHelpWiring({
  log: console.log
});

const {
  restartDetectedDesktopClient
} = createDesktopClientRestartWiring({
  fs,
  aiHomeDir: AI_HOME_DIR,
  hostHomeDir: HOST_HOME_DIR,
  path,
  spawn,
  spawnSync,
  processObj: process,
  cliConfigs: CLI_CONFIGS
});

const {
  serverDaemon,
  startLocalServer,
  syncCodexAccountsToServer
} = createServerWiring({
  fs,
  path,
  spawn,
  spawnSync,
  fetchImpl: fetch,
  processObj: process,
  ensureDir,
  parseServerServeArgs,
  readServerConfig: () => readServerConfig({ fs, aiHomeDir: AI_HOME_DIR }),
  writeServerConfig: (config) => writeServerConfig(config, { fs, aiHomeDir: AI_HOME_DIR }),
  aiHomeDir: AI_HOME_DIR,
  hostHomeDir: HOST_HOME_DIR,
  enableCodexCliHook: true,
  enableCodexDesktopAppHook: isEnvEnabled('AIH_SERVER_CODEX_DESKTOP_HOOK', true),
  pidFile: AIH_SERVER_PID_FILE,
  logFile: AIH_SERVER_LOG_FILE,
  launchdLabel: AIH_SERVER_LAUNCHD_LABEL,
  launchdPlist: AIH_SERVER_LAUNCHD_PLIST,
  entryFilePath: __filename,
  resolveCliPath,
  usageIndexBgRefreshLimit: USAGE_INDEX_BG_REFRESH_LIMIT,
  ensureAccountUsageRefreshScheduler,
  refreshAccountStateIndexForProvider,
  startLocalServerModule,
  http,
  getToolAccountIds,
  getToolConfigDir,
  getProfileDir,
  checkStatus,
  ensureSessionStoreLinks,
  syncGlobalConfigToHost,
  getLastUsageProbeError,
  getLastUsageProbeState,
  ensureUsageSnapshotAsync
});

const ptyRuntime = createPtyRuntime(createPtyRuntimeDeps({
  path,
  fs,
  processObj: process,
  pty: require('node-pty'),
  spawn,
  execSync,
  resolveCliPath,
  readServerConfig: () => readServerConfig({ fs, aiHomeDir: AI_HOME_DIR }),
  serverDaemon,
  buildPtyLaunch: require('../runtime/pty-launch').buildPtyLaunch,
  resolveWindowsBatchLaunch: require('../runtime/pty-launch').resolveWindowsBatchLaunch,
  shouldEnableShellDrawer: require('./services/pty/shell-drawer').shouldEnableShellDrawer,
  isShellDrawerToggleSequence: require('./services/pty/shell-drawer').isShellDrawerToggleSequence,
  resolveShellDrawerLaunch: require('./services/pty/shell-drawer').resolveShellDrawerLaunch,
  getShellDrawerPtyRows: require('./services/pty/shell-drawer').getShellDrawerPtyRows,
  getShellDrawerTotalHeight: require('./services/pty/shell-drawer').getShellDrawerTotalHeight,
  readUsageConfig,
  cliConfigs: CLI_CONFIGS,
  aiHomeDir: AI_HOME_DIR,
  hostHomeDir: HOST_HOME_DIR,
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
  refreshIndexedStateForAccount
}));

const rootRouterDeps = createRootDispatchWiring({
  fs,
  path,
  os,
  fse,
  crypto,
  execSync,
  readline,
  consoleImpl: console,
  processObj: process,
  aiHomeDir: AI_HOME_DIR,
  hostHomeDir: HOST_HOME_DIR,
  profilesDir: PROFILES_DIR,
  usageSnapshotSchemaVersion: USAGE_SNAPSHOT_SCHEMA_VERSION,
  usageSourceCodex: USAGE_SOURCE_CODEX,
  usageSourceGemini: USAGE_SOURCE_GEMINI,
  usageSourceClaudeOauth: USAGE_SOURCE_CLAUDE_OAUTH,
  getUsageCachePath,
  readUsageCache,
  hasAgeBinary,
  tryAutoInstallAge,
  getAgeCompatibleSshPublicKeys,
  getAgeCompatibleSshPrivateKeys,
  getSshKeys,
  isAgeArmoredData,
  runAgeEncrypt,
  runAgeDecrypt,
  loadRsaPrivateKey,
  decryptSshRsaEnvelope,
  isPasswordArchiveFile,
  encryptTarWithPassword,
  decryptPasswordArchive,
  buildPasswordEnvelope,
  decryptPasswordEnvelope,
  parseEnvelope,
  decryptLegacyEnvelope,
  serializeEnvelope,
  ensureAesSuffix,
  defaultExportName,
  parseExportArgs,
  parseImportArgs,
  getDefaultParallelism,
  expandSelectorsToPaths,
  renderStageProgress,
  exportCliproxyapiCodexAuths,
  importCliproxyapiCodexAuths,
  restoreProfilesFromExtractedBackup,
  getLikelyRsaSshPrivateKeys,
  printRestoreDetails,
  fetchImpl: fetch,
  http,
  serverLogFile: AIH_SERVER_LOG_FILE,
  getToolAccountIds,
  getToolConfigDir,
  getProfileDir,
  checkStatus,
  getLastUsageProbeError,
  getLastUsageProbeState,
  ensureUsageSnapshotAsync,
  syncCodexAccountsToServer,
  startLocalServerModule: startLocalServer,
  runServerCommand,
  showServerUsage,
  serverDaemon,
  parseServerSyncArgs,
  parseServerServeArgs,
  parseServerEnvArgs,
  askYesNo,
  showCliUsage,
  showLsHelp,
  listProfiles,
  countProfiles,
  showCodexPolicy,
  setCodexPolicy,
  restartDetectedDesktopClient,
  printAllUsageSnapshots,
  printUsageSnapshot,
  printUsageSnapshotAsync,
  parseCodexBulkImportArgs,
  importCodexTokensFromOutput,
  runUnifiedImport,
  extractActiveEnv,
  findEnvSandbox,
  getNextId,
  createAccount,
  runCliPty: ptyRuntime.runCliPtyTracked,
  getNextAvailableId,
  setAccountOperationalStatus,
  getAccountQuotaState,
  ensureSessionStoreLinks,
  syncGlobalConfigToHost,
  cleanupCodexAccounts,
  parseDeleteSelectorTokens,
  deleteAccountsForCli,
  deleteAllAccountsForCli,
  log: console.log,
  error: console.error,
  buildUsageProbePayload,
  buildUsageProbePayloadAsync,
  showHelp,
  showLsHelp,
  listProfiles,
  countProfiles,
  runGlobalAccountImport,
  runDevCommand,
  runBackupCommand,
  runServerEntry,
  runUpdateCommand,
  runAiCliCommandRouter
});

// Root command dispatch stays thin here; branch logic lives in commands/root/router.
runCliRootRouter(process.argv.slice(2), rootRouterDeps).catch((e) => {
  console.error(`\x1b[31m[aih] root router failed: ${e.message}\x1b[0m`);
  process.exit(1);
});
