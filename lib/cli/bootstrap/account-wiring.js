'use strict';

const { createAccountStatusChecker } = require('../services/account/status');
const { createAccountStateRegistryService } = require('../services/account/state-registry');
const { createAccountActivityTrackerService } = require('../services/account/activity-tracker');
const { createAccountSelectionService } = require('../services/account/selection');
const { createAccountCleanupService } = require('../services/account/cleanup');

function createAccountCoreWiring(deps = {}, factories = {}) {
  const buildAccountStatusChecker = factories.createAccountStatusChecker || createAccountStatusChecker;
  const buildAccountStateRegistryService = factories.createAccountStateRegistryService || createAccountStateRegistryService;
  const buildAccountActivityTrackerService = factories.createAccountActivityTrackerService || createAccountActivityTrackerService;

  const accountStateRegistryService = buildAccountStateRegistryService({
    fs: deps.fs,
    aiHomeDir: deps.aiHomeDir,
    getProfileDir: deps.getProfileDir,
    stateIndexClient: deps.stateIndexClient
  });
  const {
    getAccountStateIndex,
    getAccountStateService,
    getAccountQueryService
  } = accountStateRegistryService;

  const accountActivityTrackerService = buildAccountActivityTrackerService();
  const { lastActiveAccountByCli, markActiveAccount } = accountActivityTrackerService;

  const checkStatus = buildAccountStatusChecker({
    fs: deps.fs,
    path: deps.path,
    BufferImpl: deps.BufferImpl,
    cliConfigs: deps.cliConfigs,
    readClaudeKeychain: deps.readClaudeKeychain
  });

  return {
    getAccountStateIndex,
    getAccountStateService,
    getAccountQueryService,
    lastActiveAccountByCli,
    markActiveAccount,
    checkStatus
  };
}

function createAccountSelectionWiring(deps = {}, factories = {}) {
  const buildAccountSelectionService = factories.createAccountSelectionService || createAccountSelectionService;

  const accountSelectionService = buildAccountSelectionService({
    path: deps.path,
    fs: deps.fs,
    profilesDir: deps.profilesDir,
    getAccountStateIndex: deps.getAccountStateIndex,
    accountStateService: deps.accountStateService,
    accountQueryService: deps.accountQueryService,
    getProfileDir: deps.getProfileDir,
    getToolAccountIds: deps.getToolAccountIds,
    checkStatus: deps.checkStatus,
    stateIndexClient: deps.stateIndexClient,
    refreshIndexedStateForAccount: deps.refreshIndexedStateForAccount,
    readServerConfig: deps.readServerConfig
  });

  const { getNextAvailableId, getNextLoginableId } = accountSelectionService;
  return { getNextAvailableId, getNextLoginableId };
}

module.exports = {
  createAccountCoreWiring,
  createAccountSelectionWiring,
  createAccountCleanupWiring
};

function createAccountCleanupWiring(deps = {}, factories = {}) {
  const buildAccountCleanupService = factories.createAccountCleanupService || createAccountCleanupService;
  const accountCleanupService = buildAccountCleanupService({
    fs: deps.fs,
    path: deps.path,
    profilesDir: deps.profilesDir,
    getProfileDir: deps.getProfileDir,
    getAccountStateIndex: deps.getAccountStateIndex,
    accountStateService: deps.accountStateService
  });
  const { parseDeleteSelectorTokens, deleteAccountsForCli, deleteAllAccountsForCli } = accountCleanupService;
  return { parseDeleteSelectorTokens, deleteAccountsForCli, deleteAllAccountsForCli };
}
