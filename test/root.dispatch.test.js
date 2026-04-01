const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createRootCommandContexts,
  createRootRouterDeps,
  createRootDispatchWiring
} = require('../lib/cli/bootstrap/root-dispatch');

test('createRootCommandContexts builds all root command contexts', () => {
  const deps = {
    fs: {},
    path: {},
    ensureDir: () => {},
    getUsageCachePath: () => '/tmp/u.json',
    readUsageCache: () => null,
    usageSnapshotSchemaVersion: 2,
    usageSourceCodex: 'codex',
    usageSourceGemini: 'gemini',
    usageSourceClaudeOauth: 'claude',
    log: () => {},
    error: () => {},
    os: {},
    fse: {},
    execSync: () => '',
    readline: {},
    consoleImpl: {},
    processObj: {},
    aiHomeDir: '/tmp/aih',
    hostHomeDir: '/tmp',
    hasAgeBinary: () => true,
    tryAutoInstallAge: () => false,
    getAgeCompatibleSshPublicKeys: () => [],
    getAgeCompatibleSshPrivateKeys: () => [],
    getSshKeys: () => [],
    isAgeArmoredData: () => false,
    runAgeEncrypt: () => '',
    runAgeDecrypt: () => '',
    loadRsaPrivateKey: () => ({}),
    decryptSshRsaEnvelope: () => '',
    buildPasswordEnvelope: () => '',
    decryptPasswordEnvelope: () => '',
    parseEnvelope: () => ({}),
    decryptLegacyEnvelope: () => '',
    serializeEnvelope: () => '',
    ensureAesSuffix: (s) => s,
    defaultExportName: () => 'x',
    parseExportArgs: () => ({}),
    parseImportArgs: () => ({}),
    getDefaultParallelism: () => 8,
    expandSelectorsToPaths: () => [],
    renderStageProgress: () => '',
    exportCliproxyapiCodexAuths: () => ({}),
    restoreProfilesFromExtractedBackup: () => ({}),
    getLikelyRsaSshPrivateKeys: () => [],
    printRestoreDetails: () => {},
    fetchImpl: async () => ({}),
    http: {},
    serverLogFile: '/tmp/server.log',
    getToolAccountIds: () => [],
    getToolConfigDir: () => '',
    getProfileDir: () => '',
    checkStatus: () => ({}),
    syncCodexAccountsToServer: async () => ({}),
    startLocalServerModule: async () => ({}),
    runServerCommand: () => 0,
    showServerUsage: () => {},
    serverDaemon: {},
    parseServerSyncArgs: () => ({}),
    parseServerServeArgs: () => ({}),
    parseServerEnvArgs: () => ({}),
    profilesDir: '/tmp/profiles',
    askYesNo: () => true,
    showCliUsage: () => {},
    showLsHelp: () => {},
    listProfiles: () => {},
    showCodexPolicy: () => {},
    setCodexPolicy: () => {},
    clearExhausted: () => {},
    printAllUsageSnapshots: () => {},
    printUsageSnapshot: () => {},
    parseCodexBulkImportArgs: () => ({}),
    importCodexTokensFromOutput: async () => ({}),
    extractActiveEnv: () => ({}),
    findEnvSandbox: () => ({}),
    getNextId: () => 1,
    createAccount: () => {},
    runCliPty: () => {},
    getNextAvailableId: () => 1,
    syncExhaustedStateFromUsage: () => {},
    isExhausted: () => false,
    syncGlobalConfigToHost: () => {}
  };

  const contexts = createRootCommandContexts(deps);
  assert.equal(typeof contexts.devContext, 'object');
  assert.equal(typeof contexts.backupContext, 'object');
  assert.equal(typeof contexts.serverEntryContext, 'object');
  assert.equal(typeof contexts.aiCliContext, 'object');
  assert.equal(contexts.devContext.usageConstants.schemaVersion, 2);
  assert.equal(contexts.aiCliContext.HOST_HOME_DIR, '/tmp');
  assert.equal(typeof contexts.backupContext.exportCliproxyapiCodexAuths, 'function');
  assert.equal(typeof contexts.backupContext.getDefaultParallelism, 'function');
});

test('createRootRouterDeps keeps exact handler references', () => {
  const runDevCommand = () => {};
  const runBackupCommand = () => {};
  const runServerEntry = () => {};
  const runAiCliCommandRouter = () => {};
  const deps = createRootRouterDeps({
    processObj: {},
    consoleImpl: {},
    fs: {},
    buildUsageProbePayload: () => ({}),
    showHelp: () => {},
    showLsHelp: () => {},
    listProfiles: () => {},
    runGlobalAccountImport: async () => ({}),
    parseCodexBulkImportArgs: () => ({}),
    importCodexTokensFromOutput: async () => ({}),
    refreshAccountStateIndexForProvider: () => {},
    runDevCommand,
    devContext: {},
    runBackupCommand,
    backupContext: {},
    runServerEntry,
    serverEntryContext: {},
    runAiCliCommandRouter,
    aiCliContext: {}
  });

  assert.equal(deps.runDevCommand, runDevCommand);
  assert.equal(deps.runBackupCommand, runBackupCommand);
  assert.equal(deps.runServerEntry, runServerEntry);
  assert.equal(deps.runAiCliCommandRouter, runAiCliCommandRouter);
});

test('createRootDispatchWiring composes contexts and router deps in one call', () => {
  const runDevCommand = () => {};
  const runBackupCommand = () => {};
  const runServerEntry = () => {};
  const runAiCliCommandRouter = () => {};
  const deps = createRootDispatchWiring({
    fs: {},
    path: {},
    os: {},
    fse: {},
    execSync: () => '',
    readline: {},
    consoleImpl: {},
    processObj: {},
    aiHomeDir: '/tmp/aih',
    hostHomeDir: '/tmp',
    profilesDir: '/tmp/profiles',
    usageSnapshotSchemaVersion: 2,
    usageSourceCodex: 'codex',
    usageSourceGemini: 'gemini',
    usageSourceClaudeOauth: 'claude',
    getUsageCachePath: () => '/tmp/u.json',
    readUsageCache: () => null,
    hasAgeBinary: () => true,
    tryAutoInstallAge: () => false,
    getAgeCompatibleSshPublicKeys: () => [],
    getAgeCompatibleSshPrivateKeys: () => [],
    getSshKeys: () => [],
    isAgeArmoredData: () => false,
    runAgeEncrypt: () => '',
    runAgeDecrypt: () => '',
    loadRsaPrivateKey: () => ({}),
    decryptSshRsaEnvelope: () => '',
    buildPasswordEnvelope: () => '',
    decryptPasswordEnvelope: () => '',
    parseEnvelope: () => ({}),
    decryptLegacyEnvelope: () => '',
    serializeEnvelope: () => '',
    ensureAesSuffix: (s) => s,
    defaultExportName: () => 'x',
    parseExportArgs: () => ({}),
    parseImportArgs: () => ({}),
    expandSelectorsToPaths: () => [],
    renderStageProgress: () => '',
    exportCliproxyapiCodexAuths: () => ({}),
    restoreProfilesFromExtractedBackup: () => ({}),
    getLikelyRsaSshPrivateKeys: () => [],
    printRestoreDetails: () => {},
    fetchImpl: async () => ({}),
    http: {},
    serverLogFile: '/tmp/s.log',
    getToolAccountIds: () => [],
    getToolConfigDir: () => '',
    getProfileDir: () => '',
    checkStatus: () => ({}),
    syncCodexAccountsToServer: async () => ({}),
    startLocalServerModule: async () => ({}),
    runServerCommand: () => 0,
    showServerUsage: () => {},
    serverDaemon: {},
    parseServerSyncArgs: () => ({}),
    parseServerServeArgs: () => ({}),
    parseServerEnvArgs: () => ({}),
    askYesNo: () => true,
    showCliUsage: () => {},
    showLsHelp: () => {},
    listProfiles: () => {},
    showCodexPolicy: () => {},
    setCodexPolicy: () => {},
    clearExhausted: () => {},
    printAllUsageSnapshots: () => {},
    printUsageSnapshot: () => {},
    parseCodexBulkImportArgs: () => ({}),
    importCodexTokensFromOutput: async () => ({}),
    extractActiveEnv: () => ({}),
    findEnvSandbox: () => ({}),
    getNextId: () => 1,
    createAccount: () => {},
    runCliPty: () => {},
    getNextAvailableId: () => 1,
    syncExhaustedStateFromUsage: () => {},
    isExhausted: () => false,
    syncGlobalConfigToHost: () => {},
    log: () => {},
    error: () => {},
    buildUsageProbePayload: () => ({}),
    showHelp: () => {},
    runGlobalAccountImport: async () => ({}),
    refreshAccountStateIndexForProvider: () => {},
    runDevCommand,
    runBackupCommand,
    runServerEntry,
    runAiCliCommandRouter
  });

  assert.equal(typeof deps.devContext, 'object');
  assert.equal(typeof deps.backupContext, 'object');
  assert.equal(typeof deps.serverEntryContext, 'object');
  assert.equal(typeof deps.aiCliContext, 'object');
  assert.equal(deps.runDevCommand, runDevCommand);
  assert.equal(deps.runBackupCommand, runBackupCommand);
  assert.equal(deps.runServerEntry, runServerEntry);
  assert.equal(deps.runAiCliCommandRouter, runAiCliCommandRouter);
});
