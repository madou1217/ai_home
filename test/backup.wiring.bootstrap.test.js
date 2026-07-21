const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createBackupCryptoWiring,
  createBackupHelperWiring,
  createBackupExportWiring
} = require('../lib/cli/bootstrap/backup-wiring');

test('createBackupCryptoWiring maps crypto dependencies and exports', () => {
  let receivedArg = null;
  const fakeService = {
    getSshKeys: () => [],
    getLikelyRsaSshPrivateKeys: () => [],
    hasAgeBinary: () => true,
    tryAutoInstallAge: () => false,
    getAgeCompatibleSshPublicKeys: () => [],
    getAgeCompatibleSshPrivateKeys: () => [],
    isAgeArmoredData: () => false,
    runAgeEncrypt: () => '',
    runAgeDecrypt: () => '',
    loadRsaPrivateKey: () => ({}),
    decryptSshRsaEnvelope: () => '',
    isPasswordArchiveFile: () => false,
    encryptTarWithPassword: async () => {},
    decryptPasswordArchive: async () => {},
    buildPasswordEnvelope: () => '',
    decryptPasswordEnvelope: () => '',
    serializeEnvelope: () => '',
    parseEnvelope: () => ({}),
    decryptLegacyEnvelope: () => ''
  };

  const out = createBackupCryptoWiring({
    fs: {},
    path: {},
    crypto: {},
    spawnSync: () => ({}),
    execSync: () => '',
    commandExists: () => true,
    askYesNo: () => true,
    processObj: {},
    hostHomeDir: '/tmp/home',
    exportMagic: 'm',
    exportVersion: 1,
    ageSshKeyTypes: ['rsa']
  }, {
    createBackupCryptoService: (arg) => {
      receivedArg = arg;
      return fakeService;
    }
  });

  assert.equal(out.getSshKeys, fakeService.getSshKeys);
  assert.equal(out.encryptTarWithPassword, fakeService.encryptTarWithPassword);
  assert.equal(out.decryptPasswordArchive, fakeService.decryptPasswordArchive);
  assert.equal(out.decryptLegacyEnvelope, fakeService.decryptLegacyEnvelope);
  assert.equal(receivedArg.hostHomeDir, '/tmp/home');
  assert.deepEqual(receivedArg.ageSshKeyTypes, ['rsa']);
});

test('createBackupHelperWiring maps helper dependencies and exports', () => {
  let receivedArg = null;
  const out = createBackupHelperWiring({
    fs: {},
    path: {},
    processObj: {},
    aiHomeDir: '/tmp/aih',
    cliConfigs: {}
  }, {
    createBackupHelperService: (arg) => {
      receivedArg = arg;
      return {
        ensureAesSuffix: (s) => s,
        defaultExportName: () => 'x',
        parseExportArgs: () => ({}),
        parseImportArgs: () => ({}),
        renderStageProgress: () => ''
      };
    }
  });

  assert.equal(typeof out.ensureAesSuffix, 'function');
  assert.equal(receivedArg.aiHomeDir, '/tmp/aih');
});

test('createBackupExportWiring exposes data exporters and CLIProxyAPI importer', () => {
  let receivedArg = null;
  let receivedStandardArg = null;
  const out = createBackupExportWiring({
    fs: {},
    path: {},
    aiHomeDir: '/tmp/aih',
    hostHomeDir: '/tmp/home',
    BufferImpl: Buffer,
    accountArtifactHooks: { hooks: true }
  }, {
    createCliproxyapiExportService: (arg) => {
      receivedArg = arg;
      return {
        exportCliproxyapiData: () => ({ accounts: 1 }),
        importCliproxyapiCodexAuths: () => ({ imported: 1 })
      };
    },
    createStandardFormatExportService: (arg) => {
      receivedStandardArg = arg;
      return {
        exportSub2ApiData: () => ({ accounts: 2 }),
        exportAntigravityManagerAccounts: () => ({ accounts: 1 })
      };
    }
  });

  assert.equal('exportCliproxyapiCodexAuths' in out, false);
  assert.equal(typeof out.exportCliproxyapiData, 'function');
  assert.equal(typeof out.importCliproxyapiCodexAuths, 'function');
  assert.equal(typeof out.exportSub2ApiData, 'function');
  assert.equal(typeof out.exportAntigravityManagerAccounts, 'function');
  assert.equal(receivedArg.aiHomeDir, '/tmp/aih');
  assert.equal(receivedArg.hostHomeDir, '/tmp/home');
  assert.equal(receivedArg.BufferImpl, Buffer);
  assert.deepEqual(receivedArg.accountArtifactHooks, { hooks: true });
  assert.equal(receivedStandardArg.aiHomeDir, '/tmp/aih');
});
