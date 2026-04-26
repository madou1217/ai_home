const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createHostConfigSyncWiring,
  createStateIndexClientWiring,
  createInteractionWiring
} = require('../lib/cli/bootstrap/runtime-support-wiring');

test('createHostConfigSyncWiring maps host sync dependencies', () => {
  let receivedArg = null;
  const syncer = () => {};
  const out = createHostConfigSyncWiring({
    fs: {},
    fse: {},
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
