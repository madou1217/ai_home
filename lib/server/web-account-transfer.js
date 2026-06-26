'use strict';

const path = require('node:path');
const os = require('node:os');
const fsExtra = require('fs-extra');
const { ensureDirSync } = require('./fs-compat');
const { extractCodexMetadata } = require('../account/codex-auth-metadata');
const transferCore = require('../account/transfer-core');

const { AI_CLI_CONFIGS } = require('../cli/services/ai-cli/provider-registry');
const { createCliproxyapiExportService } = require('../cli/services/backup/cliproxyapi-export');
const { createCodexBulkImportService } = require('../cli/services/ai-cli/codex-bulk-import');
const { createUnifiedImportService } = require('../cli/services/import/unified-import');

function buildCodexAuthIdentityKey(authJson) {
  return transferCore.buildOAuthIdentity('codex', authJson);
}

function buildRuntimeImportTools(deps) {
  const hostHomeDir = String((deps && deps.hostHomeDir) || '').trim() || os.homedir();
  const importCodexTokensFromOutput = createCodexBulkImportService({
    path,
    fs: deps.fs,
    crypto: require('node:crypto'),
    profilesDir: path.join(deps.aiHomeDir, 'profiles'),
    getDefaultParallelism: () => 4,
    getToolAccountIds: deps.getToolAccountIds,
    ensureDir: (target) => ensureDirSync(deps.fs, target),
    getProfileDir: deps.getProfileDir,
    getToolConfigDir: deps.getToolConfigDir,
    accountArtifactHooks: deps.accountArtifactHooks
  }).importCodexTokensFromOutput;

  const cliproxyapi = createCliproxyapiExportService({
    fs: deps.fs,
    path,
    aiHomeDir: deps.aiHomeDir,
    hostHomeDir,
    accountArtifactHooks: deps.accountArtifactHooks
  });

  const unifiedImport = createUnifiedImportService({
    fs: deps.fs,
    path,
    os,
    fse: fsExtra,
    execSync: require('node:child_process').execSync,
    spawnImpl: require('node:child_process').spawn,
    processImpl: process,
    cryptoImpl: require('node:crypto'),
    aiHomeDir: deps.aiHomeDir,
    cliConfigs: AI_CLI_CONFIGS,
    getDefaultParallelism: () => 4,
    runGlobalAccountImport: require('../cli/services/ai-cli/account-import-orchestrator').runGlobalAccountImport,
    importCliproxyapiCodexAuths: cliproxyapi.importCliproxyapiCodexAuths,
    parseCodexBulkImportArgs: createCodexBulkImportService({
      path,
      fs: deps.fs,
      crypto: require('node:crypto'),
      profilesDir: path.join(deps.aiHomeDir, 'profiles'),
      getDefaultParallelism: () => 4,
      getToolAccountIds: deps.getToolAccountIds,
      ensureDir: (target) => ensureDirSync(deps.fs, target),
      getProfileDir: deps.getProfileDir,
      getToolConfigDir: deps.getToolConfigDir,
      accountArtifactHooks: deps.accountArtifactHooks
    }).parseCodexBulkImportArgs,
    importCodexTokensFromOutput,
    getToolAccountIds: deps.getToolAccountIds,
    getProfileDir: deps.getProfileDir,
    getToolConfigDir: deps.getToolConfigDir,
    accountArtifactHooks: deps.accountArtifactHooks
  });

  return {
    importCodexTokensFromOutput,
    runUnifiedImport: unifiedImport.runUnifiedImport
  };
}

module.exports = {
  ...transferCore,
  extractCodexMetadata,
  buildCodexAuthIdentityKey,
  buildRuntimeImportTools
};
