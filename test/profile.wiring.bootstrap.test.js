const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createSessionStoreWiring,
  createProfileAccountWiring,
  createProfileListWiring
} = require('../lib/cli/bootstrap/profile-wiring');

test('createSessionStoreWiring maps session store dependencies', () => {
  let receivedArg = null;
  const getToolConfigDir = () => '/tmp/tool';
  const ensureSessionStoreLinks = () => {};

  const out = createSessionStoreWiring({
    fs: {},
    fse: {},
    path: {},
    processObj: {},
    hostHomeDir: '/tmp/home',
    cliConfigs: {},
    getProfileDir: () => '/tmp/p',
    ensureDir: () => {}
  }, {
    createSessionStoreService: (arg) => {
      receivedArg = arg;
      return { getToolConfigDir, ensureSessionStoreLinks };
    }
  });

  assert.equal(out.getToolConfigDir, getToolConfigDir);
  assert.equal(out.ensureSessionStoreLinks, ensureSessionStoreLinks);
  assert.equal(receivedArg.hostHomeDir, '/tmp/home');
});

test('createProfileAccountWiring maps account profile dependencies', () => {
  let receivedArg = null;
  const getNextId = () => 1;
  const createAccount = () => ({});

  const out = createProfileAccountWiring({
    fs: {},
    fse: {},
    path: {},
    profilesDir: '/tmp/profiles',
    hostHomeDir: '/tmp/home',
    cliConfigs: {},
    ensureSessionStoreLinks: () => {},
    askYesNo: () => true,
    getProfileDir: () => '/tmp/p'
  }, {
    createProfileAccountService: (arg) => {
      receivedArg = arg;
      return { getNextId, createAccount };
    }
  });

  assert.equal(out.getNextId, getNextId);
  assert.equal(out.createAccount, createAccount);
  assert.equal(receivedArg.profilesDir, '/tmp/profiles');
});

test('createProfileListWiring maps list dependencies', () => {
  let receivedArg = null;
  const showLsHelp = () => {};
  const listProfiles = () => {};

  const out = createProfileListWiring({
    fs: {},
    path: {},
    processObj: {},
    readline: {},
    profilesDir: '/tmp/profiles',
    cliConfigs: {},
    listPageSize: 20,
    getToolAccountIds: () => [],
    getAccountStateIndex: () => ({}),
    checkStatus: () => ({}),
    isExhausted: () => false,
    formatUsageLabel: () => 'ok',
    refreshIndexedStateForAccount: () => {}
  }, {
    createProfileListService: (arg) => {
      receivedArg = arg;
      return { showLsHelp, listProfiles };
    }
  });

  assert.equal(out.showLsHelp, showLsHelp);
  assert.equal(out.listProfiles, listProfiles);
  assert.equal(receivedArg.listPageSize, 20);
});
