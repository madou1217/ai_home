const test = require('node:test');
const assert = require('node:assert/strict');
const { createServerWiring } = require('../lib/cli/bootstrap/server-wiring');

test('createServerWiring wires daemon and local runtime factories', () => {
  const calls = {
    daemonServiceArg: null,
    daemonAdapterArg: null,
    localRuntimeArg: null
  };

  const deps = {
    fs: {},
    path: {},
    spawn: () => {},
    spawnSync: () => ({}),
    fetchImpl: async () => ({}),
    processObj: {},
    ensureDir: () => {},
    parseServerServeArgs: () => ({}),
    aiHomeDir: '/tmp/aih',
    pidFile: '/tmp/pid',
    logFile: '/tmp/log',
    launchdLabel: 'x',
    launchdPlist: '/tmp/x.plist',
    entryFilePath: '/tmp/app.js',
    usageIndexBgRefreshLimit: 1,
    ensureAccountUsageRefreshScheduler: () => {},
    refreshAccountStateIndexForProvider: () => {},
    startLocalServerModule: async () => ({}),
    http: {},
    getToolAccountIds: () => [],
    getToolConfigDir: () => '',
    getProfileDir: () => '',
    checkStatus: () => ({})
  };

  const factories = {
    createServerDaemonService: (arg) => {
      calls.daemonServiceArg = arg;
      return { daemon: true };
    },
    createServerDaemonAdapter: (arg) => {
      calls.daemonAdapterArg = arg;
      return { adapter: true };
    },
    createServerLocalRuntimeService: (arg) => {
      calls.localRuntimeArg = arg;
      return {
        startLocalServer: async () => ({ ok: true }),
        syncCodexAccountsToServer: async () => ({ ok: true })
      };
    },
    syncCodexAccountsToServerService: async () => ({ ok: true })
  };

  const out = createServerWiring(deps, factories);
  assert.equal(out.serverDaemon.adapter, true);
  assert.equal(typeof out.startLocalServer, 'function');
  assert.equal(typeof out.syncCodexAccountsToServer, 'function');
  assert.equal(calls.daemonServiceArg.pidFile, '/tmp/pid');
  assert.equal(calls.daemonAdapterArg.daemon, true);
  assert.equal(typeof calls.localRuntimeArg.syncCodexAccountsToServerService, 'function');
  assert.equal(calls.localRuntimeArg.startLocalServerDeps.logFile, '/tmp/log');
});
