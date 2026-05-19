const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createBackupRestoreWiring,
  createBackupCryptoWiring,
  createBackupHelperWiring,
  createBackupExportWiring
} = require('../lib/cli/bootstrap/backup-wiring');

test('createBackupRestoreWiring maps restore dependencies', () => {
  let receivedArg = null;
  const printRestoreDetails = () => {};
  const restoreProfilesFromExtractedBackup = () => {};

  const out = createBackupRestoreWiring({
    fs: {},
    path: {},
    fse: {},
    ensureDir: () => {},
    profilesDir: '/tmp/profiles',
    checkStatus: () => ({ configured: true })
  }, {
    createBackupRestoreService: (arg) => {
      receivedArg = arg;
      return { printRestoreDetails, restoreProfilesFromExtractedBackup };
    }
  });

  assert.equal(out.printRestoreDetails, printRestoreDetails);
  assert.equal(out.restoreProfilesFromExtractedBackup, restoreProfilesFromExtractedBackup);
  assert.equal(receivedArg.profilesDir, '/tmp/profiles');
});

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
        renderStageProgress: () => '',
        expandSelectorsToPaths: () => []
      };
    }
  });

  assert.equal(typeof out.ensureAesSuffix, 'function');
  assert.equal(typeof out.expandSelectorsToPaths, 'function');
  assert.equal(receivedArg.aiHomeDir, '/tmp/aih');
});

test('createBackupExportWiring maps CLIProxyAPI export service', () => {
  let receivedArg = null;
  const out = createBackupExportWiring({
    fs: {},
    path: {},
    aiHomeDir: '/tmp/aih',
    hostHomeDir: '/tmp/home',
    BufferImpl: Buffer
  }, {
    createCliproxyapiExportService: (arg) => {
      receivedArg = arg;
      return {
        exportCliproxyapiCodexAuths: () => ({ exported: 1 })
      };
    }
  });

  assert.equal(typeof out.exportCliproxyapiCodexAuths, 'function');
  assert.equal(receivedArg.aiHomeDir, '/tmp/aih');
  assert.equal(receivedArg.hostHomeDir, '/tmp/home');
  assert.equal(receivedArg.BufferImpl, Buffer);
});
