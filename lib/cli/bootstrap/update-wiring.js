'use strict';

const { createSelfUpdateService } = require('../services/update/self-update');

function createUpdateWiring(deps = {}, factories = {}) {
  const buildSelfUpdateService = factories.createSelfUpdateService || createSelfUpdateService;
  const selfUpdateService = buildSelfUpdateService({
    fs: deps.fs,
    path: deps.path,
    fetchImpl: deps.fetchImpl,
    spawnSyncImpl: deps.spawnSync,
    processObj: deps.processObj,
    packageInfo: deps.packageInfo,
    hostHomeDir: deps.hostHomeDir,
    cliEntryFilePath: deps.cliEntryFilePath,
    log: deps.log,
    error: deps.error
  });

  const { runUpdateCommand } = selfUpdateService;
  return {
    runUpdateCommand
  };
}

module.exports = {
  createUpdateWiring
};
