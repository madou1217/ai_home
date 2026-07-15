const test = require('node:test');
const assert = require('node:assert/strict');
const { createServerWiring } = require('../lib/cli/bootstrap/server-wiring');

test('createServerWiring wires daemon and local runtime factories', () => {
  const calls = {
    daemonServiceArg: null,
    daemonAdapterArg: null,
    localRuntimeArg: null,
    desktopHookActivations: 0
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
    readServerConfig: () => ({}),
    buildServerArgsFromConfig: () => [],
    aiHomeDir: '/tmp/aih',
    hostHomeDir: '/tmp',
    pidFile: '/tmp/pid',
    logFile: '/tmp/log',
    launchdLabel: 'x',
    launchdPlist: '/tmp/x.plist',
    entryFilePath: '/tmp/app.js',
    enableCodexDesktopAppHook: true,
    resolveCliPath: () => '/usr/bin/codex',
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
    syncCodexAccountsToServerService: async () => ({ ok: true }),
    createCodexDesktopHookService: () => ({
      activate() {
        calls.desktopHookActivations += 1;
        return { ok: true, enabled: true };
      }
    })
  };

  const out = createServerWiring(deps, factories);
  assert.equal(out.serverDaemon.adapter, true);
  assert.equal(typeof out.startLocalServer, 'function');
  assert.equal(typeof out.syncCodexAccountsToServer, 'function');
  assert.equal(calls.daemonServiceArg.pidFile, '/tmp/pid');
  assert.equal(calls.daemonServiceArg.hostHomeDir, '/tmp');
  assert.equal(typeof calls.daemonServiceArg.readServerConfig, 'function');
  assert.equal(typeof calls.daemonServiceArg.buildServerArgsFromConfig, 'function');
  assert.equal(typeof calls.daemonServiceArg.prepareBackgroundStart, 'function');
  assert.deepEqual(calls.daemonServiceArg.prepareBackgroundStart(), { ok: true, enabled: true });
  assert.equal(calls.desktopHookActivations, 1);
  assert.equal(calls.daemonAdapterArg.daemon, true);
  assert.equal(typeof calls.localRuntimeArg.syncCodexAccountsToServerService, 'function');
  assert.equal(calls.localRuntimeArg.syncCodexDeps.aiHomeDir, '/tmp/aih');
  assert.equal(Object.prototype.hasOwnProperty.call(calls.localRuntimeArg.syncCodexDeps, 'getToolAccountIds'), false);
  assert.equal(calls.localRuntimeArg.startLocalServerDeps.logFile, '/tmp/log');
  assert.equal(calls.localRuntimeArg.startLocalServerDeps.hostHomeDir, '/tmp');
  assert.equal(calls.localRuntimeArg.startLocalServerDeps.fetchImpl, deps.fetchImpl);
  assert.equal(typeof calls.localRuntimeArg.startLocalServerDeps.resolveCliPath, 'function');
});
