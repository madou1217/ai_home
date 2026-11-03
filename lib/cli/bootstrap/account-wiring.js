'use strict';

const { createAccountStatusChecker } = require('../services/account/status');
const { createAccountStateRegistryService } = require('../services/account/state-registry');
const { createAccountActivityTrackerService } = require('../services/account/activity-tracker');
const { createAccountSelectionService } = require('../services/account/selection');
const { createAccountCleanupService } = require('../services/account/cleanup');
const {
  isAccountRef,
  resolveAccountRefByCliId
} = require('../../server/account-ref-store');

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

  const checkAccountStatus = buildAccountStatusChecker({
    fs: deps.fs,
    path: deps.path,
    BufferImpl: deps.BufferImpl,
    cliConfigs: deps.cliConfigs,
    readClaudeKeychain: deps.readClaudeKeychain,
    aiHomeDir: deps.aiHomeDir
  });

  function checkStatus(provider, accountSelector) {
    const value = String(accountSelector || '').trim();
    const resolved = isAccountRef(value)
      ? { accountRef: value }
      : resolveAccountRefByCliId(
        deps.fs,
        deps.aiHomeDir,
        provider,
        value,
        { bestEffort: true }
      );
    const accountRef = String(resolved && resolved.accountRef || '');
    return accountRef
      ? checkAccountStatus(provider, accountRef)
      : { configured: false, accountName: 'Unknown' };
  }

  return {
    getAccountStateIndex,
    getAccountStateService,
    getAccountQueryService,
    lastActiveAccountByCli,
    markActiveAccount,
    checkAccountStatus,
    checkStatus
  };
}

function createAccountSelectionWiring(deps = {}, factories = {}) {
  const buildAccountSelectionService = factories.createAccountSelectionService || createAccountSelectionService;

  const accountSelectionService = buildAccountSelectionService({
    fs: deps.fs,
    aiHomeDir: deps.aiHomeDir,
    getAccountStateIndex: deps.getAccountStateIndex,
    accountStateService: deps.accountStateService,
    accountQueryService: deps.accountQueryService,
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
    aiHomeDir: deps.aiHomeDir,
    processObj: deps.processObj,
    hostHomeDir: deps.hostHomeDir,
    ensureSessionStoreLinks: deps.ensureSessionStoreLinks,
    getAccountStateIndex: deps.getAccountStateIndex,
    accountStateService: deps.accountStateService
  });
  const { parseDeleteSelectorTokens, deleteAccountsForCli, deleteAllAccountsForCli } = accountCleanupService;
  return { parseDeleteSelectorTokens, deleteAccountsForCli, deleteAllAccountsForCli };
}
