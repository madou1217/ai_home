const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createAccountCoreWiring,
  createAccountSelectionWiring,
  createAccountCleanupWiring
} = require('../lib/cli/bootstrap/account-wiring');

test('createAccountCoreWiring composes state registry, activity tracker and status checker', () => {
  const calls = {
    stateRegistryArg: null,
    statusCheckerArg: null,
    activityCalled: false
  };

  const getAccountStateIndex = () => ({});
  const lastActiveAccountByCli = {};
  const markActiveAccount = () => {};
  const checkStatus = () => ({ configured: true });

  const out = createAccountCoreWiring({
    fs: {},
    path: {},
    aiHomeDir: '/tmp/aih',
    BufferImpl: Buffer,
    cliConfigs: {}
  }, {
    createAccountStateRegistryService: (arg) => {
      calls.stateRegistryArg = arg;
      return { getAccountStateIndex };
    },
    createAccountActivityTrackerService: () => {
      calls.activityCalled = true;
      return { lastActiveAccountByCli, markActiveAccount };
    },
    createAccountStatusChecker: (arg) => {
      calls.statusCheckerArg = arg;
      return checkStatus;
    }
  });

  assert.equal(out.getAccountStateIndex, getAccountStateIndex);
  assert.equal(out.lastActiveAccountByCli, lastActiveAccountByCli);
  assert.equal(out.markActiveAccount, markActiveAccount);
  assert.equal(out.checkStatus, checkStatus);
  assert.equal(calls.stateRegistryArg.aiHomeDir, '/tmp/aih');
  assert.equal(calls.activityCalled, true);
  assert.equal(calls.statusCheckerArg.BufferImpl, Buffer);
});

test('createAccountSelectionWiring maps usage-aware selection dependencies', () => {
  let selectionArg = null;
  const getNextAvailableId = () => 10086;

  const out = createAccountSelectionWiring({
    path: {},
    fs: {},
    profilesDir: '/tmp/profiles',
    getAccountStateIndex: () => ({}),
    getProfileDir: () => '/tmp/p',
    getToolAccountIds: () => ['10086'],
    checkStatus: () => ({ configured: true }),
    syncExhaustedStateFromUsage: () => {},
    isExhausted: () => false,
    stateIndexClient: {},
    ensureUsageSnapshot: async () => ({}),
    readUsageCache: () => null,
    getUsageRemainingPercentValues: () => [95]
  }, {
    createAccountSelectionService: (arg) => {
      selectionArg = arg;
      return { getNextAvailableId };
    }
  });

  assert.equal(out.getNextAvailableId, getNextAvailableId);
  assert.equal(selectionArg.profilesDir, '/tmp/profiles');
  assert.equal(typeof selectionArg.getUsageRemainingPercentValues, 'function');
});

test('createAccountCleanupWiring maps cleanup dependencies', () => {
  let cleanupArg = null;
  const cleanupCodexAccounts = async () => ({ removedAccounts: [] });
  const parseDeleteSelectorTokens = () => [];
  const deleteAccountsForCli = () => ({ deletedIds: [], missingIds: [] });
  const deleteAllAccountsForCli = () => ({ deletedIds: [], totalBeforeDelete: 0 });

  const out = createAccountCleanupWiring({
    fs: {},
    path: {},
    hostHomeDir: '/tmp/home',
    profilesDir: '/tmp/profiles',
    getProfileDir: () => '/tmp/profile',
    getAccountStateIndex: () => ({}),
    checkStatus: () => ({ configured: true }),
    readUsageCache: () => null,
    ensureUsageSnapshotAsync: async () => null,
    getLastUsageProbeError: () => ''
  }, {
    createAccountCleanupService: (arg) => {
      cleanupArg = arg;
      return { cleanupCodexAccounts, parseDeleteSelectorTokens, deleteAccountsForCli, deleteAllAccountsForCli };
    }
  });

  assert.equal(out.cleanupCodexAccounts, cleanupCodexAccounts);
  assert.equal(out.parseDeleteSelectorTokens, parseDeleteSelectorTokens);
  assert.equal(out.deleteAccountsForCli, deleteAccountsForCli);
  assert.equal(out.deleteAllAccountsForCli, deleteAllAccountsForCli);
  assert.equal(cleanupArg.hostHomeDir, '/tmp/home');
  assert.equal(cleanupArg.profilesDir, '/tmp/profiles');
});
