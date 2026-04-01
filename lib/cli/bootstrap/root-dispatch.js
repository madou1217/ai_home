'use strict';

function createRootCommandContexts(deps = {}) {
  const devContext = {
    fs: deps.fs,
    path: deps.path,
    ensureDir: deps.ensureDir,
    getUsageCachePath: deps.getUsageCachePath,
    readUsageCache: deps.readUsageCache,
    usageConstants: {
      schemaVersion: deps.usageSnapshotSchemaVersion,
      codexSource: deps.usageSourceCodex,
      geminiSource: deps.usageSourceGemini,
      claudeSource: deps.usageSourceClaudeOauth
    },
    log: deps.log,
    error: deps.error
  };

  const backupContext = {
    fs: deps.fs,
    path: deps.path,
    os: deps.os,
    fse: deps.fse,
    crypto: deps.crypto,
    execSync: deps.execSync,
    readline: deps.readline,
    consoleImpl: deps.consoleImpl,
    processImpl: deps.processObj,
    aiHomeDir: deps.aiHomeDir,
    hostHomeDir: deps.hostHomeDir,
    hasAgeBinary: deps.hasAgeBinary,
    tryAutoInstallAge: deps.tryAutoInstallAge,
    getAgeCompatibleSshPublicKeys: deps.getAgeCompatibleSshPublicKeys,
    getAgeCompatibleSshPrivateKeys: deps.getAgeCompatibleSshPrivateKeys,
    getSshKeys: deps.getSshKeys,
    isAgeArmoredData: deps.isAgeArmoredData,
    runAgeEncrypt: deps.runAgeEncrypt,
    runAgeDecrypt: deps.runAgeDecrypt,
    loadRsaPrivateKey: deps.loadRsaPrivateKey,
    decryptSshRsaEnvelope: deps.decryptSshRsaEnvelope,
    isPasswordArchiveFile: deps.isPasswordArchiveFile,
    encryptTarWithPassword: deps.encryptTarWithPassword,
    decryptPasswordArchive: deps.decryptPasswordArchive,
    buildPasswordEnvelope: deps.buildPasswordEnvelope,
    decryptPasswordEnvelope: deps.decryptPasswordEnvelope,
    parseEnvelope: deps.parseEnvelope,
    decryptLegacyEnvelope: deps.decryptLegacyEnvelope,
    serializeEnvelope: deps.serializeEnvelope,
    ensureAesSuffix: deps.ensureAesSuffix,
    defaultExportName: deps.defaultExportName,
    parseExportArgs: deps.parseExportArgs,
    parseImportArgs: deps.parseImportArgs,
    getDefaultParallelism: deps.getDefaultParallelism,
    expandSelectorsToPaths: deps.expandSelectorsToPaths,
    renderStageProgress: deps.renderStageProgress,
    exportCliproxyapiCodexAuths: deps.exportCliproxyapiCodexAuths,
    restoreProfilesFromExtractedBackup: deps.restoreProfilesFromExtractedBackup,
    getLikelyRsaSshPrivateKeys: deps.getLikelyRsaSshPrivateKeys,
    printRestoreDetails: deps.printRestoreDetails,
    runGlobalAccountImport: deps.runGlobalAccountImport,
    runUnifiedImport: deps.runUnifiedImport,
    parseCodexBulkImportArgs: deps.parseCodexBulkImportArgs,
    importCodexTokensFromOutput: deps.importCodexTokensFromOutput
  };

  const serverEntryContext = {
    fs: deps.fs,
    fetchImpl: deps.fetchImpl,
    http: deps.http,
    processObj: deps.processObj,
    aiHomeDir: deps.aiHomeDir,
    logFile: deps.serverLogFile,
    getToolAccountIds: deps.getToolAccountIds,
    getToolConfigDir: deps.getToolConfigDir,
    getProfileDir: deps.getProfileDir,
    checkStatus: deps.checkStatus,
    syncCodexAccountsToServer: deps.syncCodexAccountsToServer,
    startLocalServerModule: deps.startLocalServerModule,
    runServerCommand: deps.runServerCommand,
    showServerUsage: deps.showServerUsage,
    serverDaemon: deps.serverDaemon,
    parseServerSyncArgs: deps.parseServerSyncArgs,
    parseServerServeArgs: deps.parseServerServeArgs,
    parseServerEnvArgs: deps.parseServerEnvArgs
  };

  const aiCliContext = {
    processImpl: deps.processObj,
    fs: deps.fs,
    readLine: deps.readline,
    PROFILES_DIR: deps.profilesDir,
    HOST_HOME_DIR: deps.hostHomeDir,
    askYesNo: deps.askYesNo,
    showCliUsage: deps.showCliUsage,
    showLsHelp: deps.showLsHelp,
    listProfiles: deps.listProfiles,
    countProfiles: deps.countProfiles,
    showCodexPolicy: deps.showCodexPolicy,
    setCodexPolicy: deps.setCodexPolicy,
    getProfileDir: deps.getProfileDir,
    clearExhausted: deps.clearExhausted,
    renderStageProgress: deps.renderStageProgress,
    printAllUsageSnapshots: deps.printAllUsageSnapshots,
    printUsageSnapshot: deps.printUsageSnapshot,
    printUsageSnapshotAsync: deps.printUsageSnapshotAsync,
    runUnifiedImport: deps.runUnifiedImport,
    parseCodexBulkImportArgs: deps.parseCodexBulkImportArgs,
    importCodexTokensFromOutput: deps.importCodexTokensFromOutput,
    extractActiveEnv: deps.extractActiveEnv,
    findEnvSandbox: deps.findEnvSandbox,
    getNextId: deps.getNextId,
    createAccount: deps.createAccount,
    runCliPty: deps.runCliPty,
    getNextAvailableId: deps.getNextAvailableId,
    checkStatus: deps.checkStatus,
    syncExhaustedStateFromUsage: deps.syncExhaustedStateFromUsage,
    isExhausted: deps.isExhausted,
    syncGlobalConfigToHost: deps.syncGlobalConfigToHost,
    refreshAccountStateIndexForProvider: deps.refreshAccountStateIndexForProvider,
    cleanupCodexAccounts: deps.cleanupCodexAccounts,
    parseDeleteSelectorTokens: deps.parseDeleteSelectorTokens,
    deleteAccountsForCli: deps.deleteAccountsForCli,
    deleteAllAccountsForCli: deps.deleteAllAccountsForCli
  };

  return {
    devContext,
    backupContext,
    serverEntryContext,
    aiCliContext
  };
}

function createRootRouterDeps(deps = {}) {
  return {
    processObj: deps.processObj,
    consoleImpl: deps.consoleImpl,
    fs: deps.fs,
    buildUsageProbePayload: deps.buildUsageProbePayload,
    buildUsageProbePayloadAsync: deps.buildUsageProbePayloadAsync,
    showHelp: deps.showHelp,
    showLsHelp: deps.showLsHelp,
    listProfiles: deps.listProfiles,
    countProfiles: deps.countProfiles,
    runGlobalAccountImport: deps.runGlobalAccountImport,
    runUnifiedImport: deps.runUnifiedImport,
    parseCodexBulkImportArgs: deps.parseCodexBulkImportArgs,
    importCodexTokensFromOutput: deps.importCodexTokensFromOutput,
    renderStageProgress: deps.renderStageProgress,
    refreshAccountStateIndexForProvider: deps.refreshAccountStateIndexForProvider,
    runDevCommand: deps.runDevCommand,
    devContext: deps.devContext,
    runBackupCommand: deps.runBackupCommand,
    backupContext: deps.backupContext,
    runServerEntry: deps.runServerEntry,
    serverEntryContext: deps.serverEntryContext,
    runAiCliCommandRouter: deps.runAiCliCommandRouter,
    aiCliContext: deps.aiCliContext
  };
}

function createRootDispatchWiring(deps = {}) {
  const contexts = createRootCommandContexts(deps);
  return createRootRouterDeps({
    processObj: deps.processObj,
    consoleImpl: deps.consoleImpl,
    fs: deps.fs,
    buildUsageProbePayload: deps.buildUsageProbePayload,
    buildUsageProbePayloadAsync: deps.buildUsageProbePayloadAsync,
    showHelp: deps.showHelp,
    showLsHelp: deps.showLsHelp,
    listProfiles: deps.listProfiles,
    countProfiles: deps.countProfiles,
    runGlobalAccountImport: deps.runGlobalAccountImport,
    runUnifiedImport: deps.runUnifiedImport,
    parseCodexBulkImportArgs: deps.parseCodexBulkImportArgs,
    importCodexTokensFromOutput: deps.importCodexTokensFromOutput,
    renderStageProgress: deps.renderStageProgress,
    refreshAccountStateIndexForProvider: deps.refreshAccountStateIndexForProvider,
    runDevCommand: deps.runDevCommand,
    runBackupCommand: deps.runBackupCommand,
    runServerEntry: deps.runServerEntry,
    runAiCliCommandRouter: deps.runAiCliCommandRouter,
    devContext: contexts.devContext,
    backupContext: contexts.backupContext,
    serverEntryContext: contexts.serverEntryContext,
    aiCliContext: contexts.aiCliContext
  });
}

module.exports = {
  createRootCommandContexts,
  createRootRouterDeps,
  createRootDispatchWiring
};
