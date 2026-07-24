const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createAccountArtifactHookWiring,
  createHostConfigSyncWiring,
  createStateIndexClientWiring,
  createInteractionWiring
} = require('../lib/cli/bootstrap/runtime-support-wiring');

const ACCOUNT_REF = 'acct_1234567890abcdef1234';

test('createHostConfigSyncWiring maps host sync dependencies', () => {
  let receivedArg = null;
  const syncer = () => {};
  const pathImpl = {};
  const out = createHostConfigSyncWiring({
    fs: {},
    fse: {},
    path: pathImpl,
    ensureDir: () => {},
    getProfileDir: () => '/tmp/p',
    hostHomeDir: '/tmp/home',
    cliConfigs: {}
  }, {
    createHostConfigSyncer: (arg) => {
      receivedArg = arg;
      return syncer;
    }
  });

  assert.equal(out, syncer);
  assert.equal(receivedArg.hostHomeDir, '/tmp/home');
  assert.equal(receivedArg.path, pathImpl);
});

test('createStateIndexClientWiring resolves management settings from env by default', () => {
  let receivedArg = null;
  const client = {};
  const out = createStateIndexClientWiring({
    fetchImpl: async () => ({}),
    env: {
      AIH_SERVER_MANAGEMENT_URL: 'http://127.0.0.1:9999/v0/management',
      AIH_SERVER_MANAGEMENT_KEY: 'k'
    },
    abortSignalFactory: () => ({})
  }, {
    createStateIndexClient: (arg) => {
      receivedArg = arg;
      return client;
    }
  });

  assert.equal(out, client);
  assert.equal(receivedArg.managementBase, 'http://127.0.0.1:9999/v0/management');
  assert.equal(receivedArg.managementKey, 'k');
});

test('createStateIndexClientWiring refreshes management settings from server config', () => {
  let receivedArg = null;
  let config = { port: 9527, managementKey: 'first' };
  createStateIndexClientWiring({
    fetchImpl: async () => ({}),
    env: {},
    readServerConfig: () => config
  }, {
    createStateIndexClient: (arg) => {
      receivedArg = arg;
      return {};
    }
  });

  assert.equal(receivedArg.managementBase, 'http://127.0.0.1:9527/v0/management');
  assert.equal(receivedArg.managementKey, 'first');
  config = { port: 9555, managementKey: 'second' };
  assert.deepEqual(receivedArg.resolveManagementSettings(), {
    managementBase: 'http://127.0.0.1:9555/v0/management',
    managementKey: 'second'
  });
});

test('createInteractionWiring exposes askYesNo/stripAnsi from interaction service', () => {
  const askYesNo = () => true;
  const stripAnsi = (s) => s;
  let receivedArg = null;
  const out = createInteractionWiring({
    readLine: {}
  }, {
    createInteractionService: (arg) => {
      receivedArg = arg;
      return { askYesNo, stripAnsi };
    }
  });

  assert.equal(out.askYesNo, askYesNo);
  assert.equal(out.stripAnsi, stripAnsi);
  assert.deepEqual(receivedArg, { readLine: {} });
});

test('createAccountArtifactHookWiring syncs refreshed default auth to host config', () => {
  const syncCalls = [];
  let receivedArg = null;
  createAccountArtifactHookWiring({
    fs: {},
    path: {},
    aiHomeDir: '/tmp/aih',
    getProfileDir: () => '/tmp/profile',
    syncGlobalConfigToHost: (provider, accountRef) => {
      syncCalls.push({ provider, accountRef });
      return { ok: true };
    }
  }, {
    createAccountArtifactHookService: (arg) => {
      receivedArg = arg;
      return {};
    }
  });

  receivedArg.onDefaultAccountAuthUpdated({
    provider: 'claude',
    accountRef: ACCOUNT_REF
  });

  assert.deepEqual(syncCalls, [{ provider: 'claude', accountRef: ACCOUNT_REF }]);
});

test('default auth host sync failures are observable to the artifact hook', () => {
  let receivedArg = null;
  createAccountArtifactHookWiring({
    fs: {},
    path: {},
    aiHomeDir: '/tmp/aih',
    getProfileDir: () => '/tmp/profile',
    syncGlobalConfigToHost: () => ({ ok: false, reason: 'keychain_write_failed' })
  }, {
    createAccountArtifactHookService: (arg) => {
      receivedArg = arg;
      return {};
    }
  });

  assert.throws(
    () => receivedArg.onDefaultAccountAuthUpdated({ provider: 'claude', accountRef: ACCOUNT_REF }),
    /default_account_host_sync_failed:keychain_write_failed/
  );
});
