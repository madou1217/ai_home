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
    aiHomeDir: deps.aiHomeDir
  });
  const { getAccountStateIndex } = accountStateRegistryService;

  const accountActivityTrackerService = buildAccountActivityTrackerService();
  const { lastActiveAccountByCli, markActiveAccount } = accountActivityTrackerService;

  const checkStatus = buildAccountStatusChecker({
    fs: deps.fs,
    path: deps.path,
    BufferImpl: deps.BufferImpl,
    cliConfigs: deps.cliConfigs
  });

  return {
    getAccountStateIndex,
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
    getProfileDir: deps.getProfileDir,
    getToolAccountIds: deps.getToolAccountIds,
    checkStatus: deps.checkStatus,
    syncExhaustedStateFromUsage: deps.syncExhaustedStateFromUsage,
    isExhausted: deps.isExhausted,
    stateIndexClient: deps.stateIndexClient,
    ensureUsageSnapshot: deps.ensureUsageSnapshot,
    readUsageCache: deps.readUsageCache,
    getUsageRemainingPercentValues: deps.getUsageRemainingPercentValues
  });

  const { getNextAvailableId } = accountSelectionService;
  return { getNextAvailableId };
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
    hostHomeDir: deps.hostHomeDir,
    profilesDir: deps.profilesDir,
    getProfileDir: deps.getProfileDir,
    getAccountStateIndex: deps.getAccountStateIndex,
    checkStatus: deps.checkStatus,
    readUsageCache: deps.readUsageCache,
    ensureUsageSnapshotAsync: deps.ensureUsageSnapshotAsync,
    getLastUsageProbeError: deps.getLastUsageProbeError
  });
  const { cleanupCodexAccounts, parseDeleteSelectorTokens, deleteAccountsForCli, deleteAllAccountsForCli } = accountCleanupService;
  return { cleanupCodexAccounts, parseDeleteSelectorTokens, deleteAccountsForCli, deleteAllAccountsForCli };
}
