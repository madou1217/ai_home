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
    os: {},
    fse: {},
    execSync: () => '',
    spawnSync: () => ({}),
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
    exportCliproxyapiData: () => ({}),
    exportSub2ApiData: () => ({ accounts: 2 }),
    exportAntigravityManagerAccounts: () => ({ accounts: 1 }),
    getLikelyRsaSshPrivateKeys: () => [],
    printRestoreDetails: () => {},
    fetchImpl: async () => ({}),
    readServerConfig: () => ({ port: 9527 }),
    hostname: () => 'node-host',
    networkInterfaces: () => ({ en0: [] }),
    http: {},
    serverLogFile: '/tmp/server.log',
    getToolAccountIds: () => [],
    getToolConfigDir: () => '',
    getProfileDir: () => '',
    checkStatus: () => ({}),
    syncCodexAccountsToServer: async () => ({}),
    startLocalServerModule: async () => ({}),
    resolveBackgroundServerOptions: () => ({ port: 9527 }),
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
    printAllUsageSnapshots: () => {},
    printUsageSnapshot: () => {},
    parseCodexBulkImportArgs: () => ({}),
    importCodexTokensFromOutput: async () => ({}),
    extractActiveEnv: () => ({}),
    findEnvSandbox: () => ({}),
    getNextId: () => 1,
    createAccount: () => {},
    runCliPty: () => {},
    getAccountQuotaState: () => ({ quotaStatus: 'available' }),
    syncGlobalConfigToHost: () => {}
  };

  const contexts = createRootCommandContexts(deps);
  assert.equal(typeof contexts.backupContext, 'object');
  assert.equal(typeof contexts.serverEntryContext, 'object');
  assert.equal(typeof contexts.aiCliContext, 'object');
  assert.equal(typeof contexts.nodeContext, 'object');
  assert.equal(typeof contexts.globalSessionContext, 'object');
  assert.equal(contexts.aiCliContext.HOST_HOME_DIR, '/tmp');
  assert.equal(contexts.globalSessionContext.aiHomeDir, '/tmp/aih');
  assert.equal(typeof contexts.globalSessionContext.runCliPty, 'function');
  assert.equal(typeof contexts.backgroundContext.startLocalServer, 'function');
  assert.deepEqual(contexts.backgroundContext.resolveServerOptions(), { port: 9527 });
  assert.equal(contexts.backgroundContext.nodeContext, contexts.nodeContext);
  assert.equal(contexts.backgroundContext.fabricContext, contexts.fabricContext);
  assert.equal(typeof contexts.nodeContext.readServerConfig, 'function');
  assert.equal(contexts.nodeContext.hostname(), 'node-host');
  assert.deepEqual(contexts.nodeContext.networkInterfaces(), { en0: [] });
  assert.equal('setAccountOperationalStatus' in contexts.aiCliContext, false);
  assert.equal('exportCliproxyapiCodexAuths' in contexts.backupContext, false);
  assert.equal(typeof contexts.backupContext.exportCliproxyapiData, 'function');
  assert.equal(typeof contexts.backupContext.exportSub2ApiData, 'function');
  assert.equal(typeof contexts.backupContext.exportAntigravityManagerAccounts, 'function');
  assert.equal(typeof contexts.backupContext.getDefaultParallelism, 'function');
});

test('createRootRouterDeps keeps exact handler references', () => {
  const runBackupCommand = () => {};
  const runServerEntry = () => {};
  const runNodeCommandRouter = () => {};
  const runFabricCommandRouter = () => {};
  const runClipAgentCommand = () => {};
  const runSshClipboardProbeCommand = () => {};
  const runGlobalPersistentSessionsCommand = () => {};
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
    runGlobalPersistentSessionsCommand,
    globalSessionContext: {},
    runBackupCommand,
    backupContext: {},
    runServerEntry,
    serverEntryContext: {},
    runNodeCommandRouter,
    runFabricCommandRouter,
    nodeContext: {},
    fabricContext: {},
    runClipAgentCommand,
    clipAgentContext: {},
    runSshClipboardProbeCommand,
    sshClipboardContext: {},
    runAiCliCommandRouter,
    aiCliContext: {}
  });

  assert.equal('runDevCommand' in deps, false);
  assert.equal(deps.runBackupCommand, runBackupCommand);
  assert.equal(deps.runServerEntry, runServerEntry);
  assert.equal(deps.runNodeCommandRouter, runNodeCommandRouter);
  assert.equal(deps.runFabricCommandRouter, runFabricCommandRouter);
  assert.equal(deps.runClipAgentCommand, runClipAgentCommand);
  assert.equal(deps.runSshClipboardProbeCommand, runSshClipboardProbeCommand);
  assert.equal(deps.runGlobalPersistentSessionsCommand, runGlobalPersistentSessionsCommand);
  assert.equal(deps.runAiCliCommandRouter, runAiCliCommandRouter);
});

test('createRootDispatchWiring composes contexts and router deps in one call', () => {
  const runBackupCommand = () => {};
  const runServerEntry = () => {};
  const runNodeCommandRouter = () => {};
  const runFabricCommandRouter = () => {};
  const runClipAgentCommand = () => {};
  const runSshClipboardProbeCommand = () => {};
  const runAiCliCommandRouter = () => {};
  const deps = createRootDispatchWiring({
    fs: {},
    path: {},
    os: {},
    fse: {},
    execSync: () => '',
    spawnSync: () => ({}),
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
    expandSelectorsToPaths: () => [],
    renderStageProgress: () => '',
    exportCliproxyapiData: () => ({}),
    exportSub2ApiData: () => ({ accounts: 2 }),
    exportAntigravityManagerAccounts: () => ({ accounts: 1 }),
    getLikelyRsaSshPrivateKeys: () => [],
    printRestoreDetails: () => {},
    fetchImpl: async () => ({}),
    readServerConfig: () => ({ port: 9527 }),
    hostname: () => 'node-host',
    networkInterfaces: () => ({ en0: [] }),
    http: {},
    serverLogFile: '/tmp/s.log',
    getToolAccountIds: () => [],
    getToolConfigDir: () => '',
    getProfileDir: () => '',
    checkStatus: () => ({}),
    syncCodexAccountsToServer: async () => ({}),
    startLocalServerModule: async () => ({}),
    resolveBackgroundServerOptions: () => ({ port: 9527 }),
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
    printAllUsageSnapshots: () => {},
    printUsageSnapshot: () => {},
    parseCodexBulkImportArgs: () => ({}),
    importCodexTokensFromOutput: async () => ({}),
    extractActiveEnv: () => ({}),
    findEnvSandbox: () => ({}),
    getNextId: () => 1,
    createAccount: () => {},
    runCliPty: () => {},
    getAccountQuotaState: () => ({ quotaStatus: 'available' }),
    syncGlobalConfigToHost: () => {},
    buildUsageProbePayload: () => ({}),
    showHelp: () => {},
    runGlobalAccountImport: async () => ({}),
    refreshAccountStateIndexForProvider: () => {},
    runBackupCommand,
    runServerEntry,
    runNodeCommandRouter,
    runFabricCommandRouter,
    runClipAgentCommand,
    runSshClipboardProbeCommand,
    runAiCliCommandRouter
  });

  assert.equal(typeof deps.backupContext, 'object');
  assert.equal(typeof deps.backupContext.exportSub2ApiData, 'function');
  assert.equal(typeof deps.backupContext.exportAntigravityManagerAccounts, 'function');
  assert.equal(typeof deps.serverEntryContext, 'object');
  assert.equal(typeof deps.aiCliContext, 'object');
  assert.equal(typeof deps.nodeContext, 'object');
  assert.equal(typeof deps.fabricContext, 'object');
  assert.equal(typeof deps.backgroundContext, 'object');
  assert.equal(typeof deps.backgroundContext.startLocalServer, 'function');
  assert.deepEqual(deps.backgroundContext.resolveServerOptions(), { port: 9527 });
  assert.equal(typeof deps.fabricContext.spawnSync, 'function');
  assert.equal(deps.fabricContext.aiHomeDir, '/tmp/aih');
  assert.equal(deps.fabricContext.hostHomeDir, '/tmp');
  assert.equal('devContext' in deps, false);
  assert.equal('runDevCommand' in deps, false);
  assert.equal(deps.runBackupCommand, runBackupCommand);
  assert.equal(deps.runServerEntry, runServerEntry);
  assert.equal(deps.runNodeCommandRouter, runNodeCommandRouter);
  assert.equal(deps.runFabricCommandRouter, runFabricCommandRouter);
  assert.equal(deps.runClipAgentCommand, runClipAgentCommand);
  assert.equal(deps.runSshClipboardProbeCommand, runSshClipboardProbeCommand);
  assert.equal(deps.nodeContext.hostname(), 'node-host');
  assert.deepEqual(deps.nodeContext.networkInterfaces(), { en0: [] });
  assert.equal(deps.runAiCliCommandRouter, runAiCliCommandRouter);
});
