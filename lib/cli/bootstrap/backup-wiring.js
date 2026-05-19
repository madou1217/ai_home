'use strict';

const { createBackupRestoreService } = require('../services/backup/restore');
const { createBackupCryptoService } = require('../services/backup/crypto');
const { createBackupHelperService } = require('../services/backup/helpers');
const { createCliproxyapiExportService } = require('../services/backup/cliproxyapi-export');

function createBackupRestoreWiring(deps = {}, factories = {}) {
  const buildBackupRestoreService = factories.createBackupRestoreService || createBackupRestoreService;
  const backupRestoreService = buildBackupRestoreService({
    fs: deps.fs,
    path: deps.path,
    fse: deps.fse,
    ensureDir: deps.ensureDir,
    profilesDir: deps.profilesDir,
    checkStatus: deps.checkStatus
  });
  const { printRestoreDetails, restoreProfilesFromExtractedBackup } = backupRestoreService;
  return { printRestoreDetails, restoreProfilesFromExtractedBackup };
}

function createBackupCryptoWiring(deps = {}, factories = {}) {
  const buildBackupCryptoService = factories.createBackupCryptoService || createBackupCryptoService;
  const backupCryptoService = buildBackupCryptoService({
    fs: deps.fs,
    path: deps.path,
    crypto: deps.crypto,
    spawnSync: deps.spawnSync,
    execSync: deps.execSync,
    commandExists: deps.commandExists,
    askYesNo: deps.askYesNo,
    processObj: deps.processObj,
    hostHomeDir: deps.hostHomeDir,
    exportMagic: deps.exportMagic,
    exportVersion: deps.exportVersion,
    ageSshKeyTypes: deps.ageSshKeyTypes
  });
  return {
    getSshKeys: backupCryptoService.getSshKeys,
    getLikelyRsaSshPrivateKeys: backupCryptoService.getLikelyRsaSshPrivateKeys,
    hasAgeBinary: backupCryptoService.hasAgeBinary,
    tryAutoInstallAge: backupCryptoService.tryAutoInstallAge,
    getAgeCompatibleSshPublicKeys: backupCryptoService.getAgeCompatibleSshPublicKeys,
    getAgeCompatibleSshPrivateKeys: backupCryptoService.getAgeCompatibleSshPrivateKeys,
    isAgeArmoredData: backupCryptoService.isAgeArmoredData,
    runAgeEncrypt: backupCryptoService.runAgeEncrypt,
    runAgeDecrypt: backupCryptoService.runAgeDecrypt,
    loadRsaPrivateKey: backupCryptoService.loadRsaPrivateKey,
    decryptSshRsaEnvelope: backupCryptoService.decryptSshRsaEnvelope,
    isPasswordArchiveFile: backupCryptoService.isPasswordArchiveFile,
    encryptTarWithPassword: backupCryptoService.encryptTarWithPassword,
    decryptPasswordArchive: backupCryptoService.decryptPasswordArchive,
    buildPasswordEnvelope: backupCryptoService.buildPasswordEnvelope,
    decryptPasswordEnvelope: backupCryptoService.decryptPasswordEnvelope,
    serializeEnvelope: backupCryptoService.serializeEnvelope,
    parseEnvelope: backupCryptoService.parseEnvelope,
    decryptLegacyEnvelope: backupCryptoService.decryptLegacyEnvelope
  };
}

function createBackupHelperWiring(deps = {}, factories = {}) {
  const buildBackupHelperService = factories.createBackupHelperService || createBackupHelperService;
  const backupHelperService = buildBackupHelperService({
    fs: deps.fs,
    path: deps.path,
    processObj: deps.processObj,
    aiHomeDir: deps.aiHomeDir,
    cliConfigs: deps.cliConfigs
  });
  const {
    ensureAesSuffix,
    defaultExportName,
    parseExportArgs,
    parseImportArgs,
    renderStageProgress,
    expandSelectorsToPaths
  } = backupHelperService;
  return {
    ensureAesSuffix,
    defaultExportName,
    parseExportArgs,
    parseImportArgs,
    renderStageProgress,
    expandSelectorsToPaths
  };
}

function createBackupExportWiring(deps = {}, factories = {}) {
  const buildCliproxyapiExportService = factories.createCliproxyapiExportService || createCliproxyapiExportService;
  const cliproxyapiExportService = buildCliproxyapiExportService({
    fs: deps.fs,
    path: deps.path,
    aiHomeDir: deps.aiHomeDir,
    hostHomeDir: deps.hostHomeDir,
    BufferImpl: deps.BufferImpl
  });
  return {
    exportCliproxyapiCodexAuths: cliproxyapiExportService.exportCliproxyapiCodexAuths,
    importCliproxyapiCodexAuths: cliproxyapiExportService.importCliproxyapiCodexAuths
  };
}

module.exports = {
  createBackupRestoreWiring,
  createBackupCryptoWiring,
  createBackupHelperWiring,
  createBackupExportWiring
};
