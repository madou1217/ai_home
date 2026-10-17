const test = require('node:test');
const assert = require('node:assert/strict');
const { createServerWiring } = require('../lib/cli/bootstrap/server-wiring');
const { CODEX_HOOKS_ENV, parseCodexHookFlags } = require('../lib/cli/config/codex-hooks');

function captureCodexCliHookFlag(enableCodexCliHook) {
  let received;
  createServerWiring({ enableCodexCliHook }, {
    createServerDaemonService: () => ({}),
    createServerDaemonAdapter: () => ({}),
    createServerLocalRuntimeService: (options) => {
      received = options.startLocalServerDeps.enableCodexCliHook;
      return {};
    },
    syncCodexAccountsToServerService: () => {}
  });
  return received;
}

test('Codex hook flags reach the server composition with an enabled default', () => {
  const cases = [
    { env: {}, cli: true, desktop: true },
    { env: { [CODEX_HOOKS_ENV]: 'cli' }, cli: true, desktop: false },
    { env: { [CODEX_HOOKS_ENV]: '0' }, cli: false, desktop: false }
  ];

  cases.forEach(({ env, cli, desktop }) => {
    const flags = parseCodexHookFlags(env[CODEX_HOOKS_ENV]);
    assert.equal(flags.cli, cli);
    assert.equal(flags.desktop, desktop);
    assert.equal(captureCodexCliHookFlag(flags.cli), cli);
  });
});

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
    connectFabricBroker: async () => ({}),
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
  assert.equal(calls.localRuntimeArg.startLocalServerDeps.connectFabricBroker, deps.connectFabricBroker);
  assert.equal(typeof calls.localRuntimeArg.startLocalServerDeps.resolveCliPath, 'function');
});

test('createServerWiring does not hand a Go Core supervisor to the short-lived CLI daemon', () => {
  let daemonOptions;
  let supervisorBuilt = false;

  createServerWiring({ goCoreEnabled: true }, {
    createGoCoreSupervisor: () => {
      supervisorBuilt = true;
      return {};
    },
    createServerDaemonService: (options) => {
      daemonOptions = options;
      return {};
    },
    createServerDaemonAdapter: () => ({}),
    createServerLocalRuntimeService: () => ({}),
    syncCodexAccountsToServerService: () => {}
  });

  // Go Core 由长驻 Server 进程监督；CLI 进程退出后不能留下无人监督的 Go 子进程。
  assert.equal(supervisorBuilt, false);
  assert.equal(Object.prototype.hasOwnProperty.call(daemonOptions, 'goCoreSupervisor'), false);
});
