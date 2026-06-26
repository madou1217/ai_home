'use strict';

const { createStateIndexClient } = require('../services/server/state-index-client');
const { createInteractionService } = require('../services/interaction');
const { createHostConfigSyncer } = require('../../account/host-sync');
const { createAccountArtifactHookService } = require('../../account/artifact-hooks');
const { buildManagementBaseUrl } = require('../../server/server-defaults');

function createHostConfigSyncWiring(deps = {}, factories = {}) {
  const buildHostConfigSyncer = factories.createHostConfigSyncer || createHostConfigSyncer;
  return buildHostConfigSyncer({
    fs: deps.fs,
    fse: deps.fse,
    path: deps.path,
    ensureDir: deps.ensureDir,
    getProfileDir: deps.getProfileDir,
    hostHomeDir: deps.hostHomeDir,
    cliConfigs: deps.cliConfigs,
    readServerConfig: deps.readServerConfig
  });
}

function createStateIndexClientWiring(deps = {}, factories = {}) {
  const buildStateIndexClient = factories.createStateIndexClient || createStateIndexClient;
  const env = deps.env || {};
  const managementBase = deps.managementBase || env.AIH_SERVER_MANAGEMENT_URL || buildManagementBaseUrl();
  const managementKey = deps.managementKey || env.AIH_SERVER_MANAGEMENT_KEY || '';
  return buildStateIndexClient({
    fetchImpl: deps.fetchImpl,
    managementBase,
    managementKey,
    abortSignalFactory: deps.abortSignalFactory
  });
}

function createInteractionWiring(deps = {}, factories = {}) {
  const buildInteractionService = factories.createInteractionService || createInteractionService;
  const interactionService = buildInteractionService({ readLine: deps.readLine });
  const { askYesNo, stripAnsi } = interactionService;
  return { askYesNo, stripAnsi };
}

function createAccountArtifactHookWiring(deps = {}, factories = {}) {
  const buildAccountArtifactHookService = factories.createAccountArtifactHookService || createAccountArtifactHookService;
  return buildAccountArtifactHookService({
    fs: deps.fs,
    path: deps.path,
    profilesDir: deps.profilesDir,
    getProfileDir: deps.getProfileDir,
    onDefaultAccountAuthUpdated: deps.onDefaultAccountAuthUpdated,
    onAccountConfigUpdated: deps.onAccountConfigUpdated,
    onError: deps.onError
  });
}

module.exports = {
  createHostConfigSyncWiring,
  createStateIndexClientWiring,
  createInteractionWiring,
  createAccountArtifactHookWiring
};
