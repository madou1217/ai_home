'use strict';

const { createUnifiedImportService } = require('../services/import/unified-import');

function createImportWiring(deps = {}, factories = {}) {
  const buildUnifiedImportService = factories.createUnifiedImportService || createUnifiedImportService;
  const importService = buildUnifiedImportService({
    fs: deps.fs,
    path: deps.path,
    os: deps.os,
    fse: deps.fse,
    execSync: deps.execSync,
    spawnImpl: deps.spawnImpl,
    processImpl: deps.processObj,
    cryptoImpl: deps.cryptoImpl,
    aiHomeDir: deps.aiHomeDir,
    cliConfigs: deps.cliConfigs,
    getDefaultParallelism: deps.getDefaultParallelism,
    runGlobalAccountImport: deps.runGlobalAccountImport,
    importCliproxyapiCodexAuths: deps.importCliproxyapiCodexAuths,
    parseCodexBulkImportArgs: deps.parseCodexBulkImportArgs,
    importCodexTokensFromOutput: deps.importCodexTokensFromOutput
  });
  return {
    parseUnifiedImportArgs: importService.parseUnifiedImportArgs,
    runUnifiedImport: importService.runUnifiedImport
  };
}

module.exports = {
  createImportWiring
};
