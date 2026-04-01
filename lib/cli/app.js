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
  createCliHelpWiring
} = require('./bootstrap/cli-feature-wiring');
const {
  createHostConfigSyncWiring,
  createStateIndexClientWiring,
  createInteractionWiring
} = require('./bootstrap/runtime-support-wiring');
const { createStartupWiring } = require('./bootstrap/startup-wiring');

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
  cliConfigs: CLI_CONFIGS
});

const stateIndexClient = createStateIndexClientWiring({
  fetchImpl: fetch,
  env: process.env,
  abortSignalFactory: (timeoutMs) => AbortSignal.timeout(timeoutMs)
});

const {
  getAccountStateIndex,
  lastActiveAccountByCli,
  markActiveAccount,
  checkStatus
} = createAccountCoreWiring({
  fs,
  path,
  aiHomeDir: AI_HOME_DIR,
  BufferImpl: Buffer,
  cliConfigs: CLI_CONFIGS
});

const {
  askYesNo,
  stripAnsi
} = createInteractionWiring({ readLine: readline });
const {
  getToolConfigDir,
  ensureSessionStoreLinks
} = createSessionStoreWiring({
  fs,
  fse,
  path,
  processObj: process,
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
  extractActiveEnv,
  findEnvSandbox,
  isExhausted,
  clearExhausted,
  syncExhaustedStateFromUsage,
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
  getProfileDir,
  getToolAccountIds,
  checkStatus,
  syncExhaustedStateFromUsage,
  isExhausted,
  stateIndexClient,
  ensureUsageSnapshot,
  readUsageCache,
  getUsageRemainingPercentValues
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
  isExhausted,
  formatUsageLabel,
  refreshIndexedStateForAccount
});

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
  aiHomeDir: AI_HOME_DIR,
  pidFile: AIH_SERVER_PID_FILE,
  logFile: AIH_SERVER_LOG_FILE,
  launchdLabel: AIH_SERVER_LAUNCHD_LABEL,
  launchdPlist: AIH_SERVER_LAUNCHD_PLIST,
  entryFilePath: __filename,
  usageIndexBgRefreshLimit: USAGE_INDEX_BG_REFRESH_LIMIT,
  ensureAccountUsageRefreshScheduler,
  refreshAccountStateIndexForProvider,
  startLocalServerModule,
  http,
  getToolAccountIds,
  getToolConfigDir,
  getProfileDir,
  checkStatus
});

const ptyRuntime = createPtyRuntime(createPtyRuntimeDeps({
  path,
  fs,
  processObj: process,
  pty: require('node-pty'),
  spawn,
  execSync,
  resolveCliPath,
  buildPtyLaunch: require('../runtime/pty-launch').buildPtyLaunch,
  resolveWindowsBatchLaunch: require('../runtime/pty-launch').resolveWindowsBatchLaunch,
  readUsageConfig,
  cliConfigs: CLI_CONFIGS,
  aiHomeDir: AI_HOME_DIR,
  getProfileDir,
  askYesNo,
  stripAnsi,
  ensureSessionStoreLinks,
  ensureUsageSnapshot,
  ensureUsageSnapshotAsync,
  readUsageCache,
  getUsageRemainingPercentValues,
  getNextAvailableId,
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
  clearExhausted,
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
  syncExhaustedStateFromUsage,
  isExhausted,
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
  runAiCliCommandRouter
});

// Root command dispatch stays thin here; branch logic lives in commands/root/router.
runCliRootRouter(process.argv.slice(2), rootRouterDeps).catch((e) => {
  console.error(`\x1b[31m[aih] root router failed: ${e.message}\x1b[0m`);
  process.exit(1);
});
