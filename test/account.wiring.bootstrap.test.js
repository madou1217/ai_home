const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createAccountCoreWiring,
  createAccountSelectionWiring,
  createAccountCleanupWiring
} = require('../lib/cli/bootstrap/account-wiring');
const { getPublicAccountRef } = require('../lib/account/public-account-ref');

test('createAccountCoreWiring composes state registry, activity tracker and status checker', () => {
  const calls = {
    stateRegistryArg: null,
    statusCheckerArg: null,
    activityCalled: false
  };

  const getAccountStateIndex = () => ({});
  const lastActiveAccountByCli = {};
  const markActiveAccount = () => {};
  const accountRef = getPublicAccountRef('unique:wiring@example.com');
  const checkAccountStatus = () => ({ configured: true });

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
      return checkAccountStatus;
    }
  });

  assert.equal(out.getAccountStateIndex, getAccountStateIndex);
  assert.equal(out.lastActiveAccountByCli, lastActiveAccountByCli);
  assert.equal(out.markActiveAccount, markActiveAccount);
  assert.equal(out.checkAccountStatus, checkAccountStatus);
  assert.deepEqual(out.checkStatus('codex', accountRef), { configured: true });
  assert.equal(calls.stateRegistryArg.aiHomeDir, '/tmp/aih');
  assert.equal(calls.activityCalled, true);
  assert.equal(calls.statusCheckerArg.BufferImpl, Buffer);
});

test('createAccountSelectionWiring maps usage-aware selection dependencies', () => {
  let selectionArg = null;
  const getNextAvailableId = () => 10086;
  const getNextLoginableId = () => 10087;

  const out = createAccountSelectionWiring({
    fs: {},
    aiHomeDir: '/tmp/aih',
    getAccountStateIndex: () => ({}),
    checkStatus: () => ({ configured: true }),
    stateIndexClient: {},
    refreshIndexedStateForAccount: () => ({ schedulableStatus: 'schedulable', remainingPct: 95 }),
    readServerConfig: () => ({ port: 8317 })
  }, {
    createAccountSelectionService: (arg) => {
      selectionArg = arg;
      return { getNextAvailableId, getNextLoginableId };
    }
  });

  assert.equal(out.getNextAvailableId, getNextAvailableId);
  assert.equal(out.getNextLoginableId, getNextLoginableId);
  assert.equal(selectionArg.aiHomeDir, '/tmp/aih');
  assert.equal('profilesDir' in selectionArg, false);
  assert.equal(typeof selectionArg.refreshIndexedStateForAccount, 'function');
  assert.equal(typeof selectionArg.readServerConfig, 'function');
});

test('createAccountCleanupWiring maps cleanup dependencies', () => {
  let cleanupArg = null;
  const parseDeleteSelectorTokens = () => [];
  const deleteAccountsForCli = () => ({ deletedIds: [], missingIds: [] });
  const deleteAllAccountsForCli = () => ({ deletedIds: [], totalBeforeDelete: 0 });
  const ensureSessionStoreLinks = () => ({ migrated: 0, linked: 0 });

  const out = createAccountCleanupWiring({
    fs: {},
    path: {},
    aiHomeDir: '/tmp/aih',
    ensureSessionStoreLinks,
    getAccountStateIndex: () => ({}),
    accountStateService: {}
  }, {
    createAccountCleanupService: (arg) => {
      cleanupArg = arg;
      return { parseDeleteSelectorTokens, deleteAccountsForCli, deleteAllAccountsForCli };
    }
  });

  assert.equal('cleanupCodexAccounts' in out, false);
  assert.equal(out.parseDeleteSelectorTokens, parseDeleteSelectorTokens);
  assert.equal(out.deleteAccountsForCli, deleteAccountsForCli);
  assert.equal(out.deleteAllAccountsForCli, deleteAllAccountsForCli);
  assert.equal(cleanupArg.aiHomeDir, '/tmp/aih');
  assert.equal(cleanupArg.ensureSessionStoreLinks, ensureSessionStoreLinks);
  assert.equal('profilesDir' in cleanupArg, false);
  assert.equal('readUsageCache' in cleanupArg, false);
});
