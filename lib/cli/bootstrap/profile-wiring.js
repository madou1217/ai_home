'use strict';

const { createSessionStoreService } = require('../services/session-store');
const { createProfileAccountService } = require('../services/profile/account');
const { createProfileListService } = require('../services/profile/list');

function createSessionStoreWiring(deps = {}, factories = {}) {
  const buildSessionStoreService = factories.createSessionStoreService || createSessionStoreService;
  const sessionStoreService = buildSessionStoreService({
    fs: deps.fs,
    fse: deps.fse,
    path: deps.path,
    processObj: deps.processObj,
    hostHomeDir: deps.hostHomeDir,
    cliConfigs: deps.cliConfigs,
    getProfileDir: deps.getProfileDir,
    ensureDir: deps.ensureDir
  });
  const { getToolConfigDir, ensureSessionStoreLinks } = sessionStoreService;
  return { getToolConfigDir, ensureSessionStoreLinks };
}

function createProfileAccountWiring(deps = {}, factories = {}) {
  const buildProfileAccountService = factories.createProfileAccountService || createProfileAccountService;
  const profileAccountService = buildProfileAccountService({
    fs: deps.fs,
    fse: deps.fse,
    path: deps.path,
    profilesDir: deps.profilesDir,
    hostHomeDir: deps.hostHomeDir,
    cliConfigs: deps.cliConfigs,
    ensureSessionStoreLinks: deps.ensureSessionStoreLinks,
    askYesNo: deps.askYesNo,
    getProfileDir: deps.getProfileDir
  });
  const { getNextId, createAccount } = profileAccountService;
  return { getNextId, createAccount };
}

function createProfileListWiring(deps = {}, factories = {}) {
  const buildProfileListService = factories.createProfileListService || createProfileListService;
  const profileListService = buildProfileListService({
    fs: deps.fs,
    path: deps.path,
    processObj: deps.processObj,
    readline: deps.readline,
    profilesDir: deps.profilesDir,
    cliConfigs: deps.cliConfigs,
    listPageSize: deps.listPageSize,
    getToolAccountIds: deps.getToolAccountIds,
    getAccountStateIndex: deps.getAccountStateIndex,
    checkStatus: deps.checkStatus,
    isExhausted: deps.isExhausted,
    formatUsageLabel: deps.formatUsageLabel,
    refreshIndexedStateForAccount: deps.refreshIndexedStateForAccount
  });
  const { showLsHelp, listProfiles, countProfiles } = profileListService;
  return { showLsHelp, listProfiles, countProfiles };
}

module.exports = {
  createSessionStoreWiring,
  createProfileAccountWiring,
  createProfileListWiring
};
