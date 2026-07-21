const test = require('node:test');
const assert = require('node:assert/strict');
const { createServerWiring } = require('../lib/cli/bootstrap/server-wiring');
const { isEnvEnabled } = require('../lib/cli/config/env-flags');

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

test('Codex CLI hook env flag reaches the server composition with an enabled default', () => {
  const cases = [
    { env: {}, expected: true },
    { env: { AIH_SERVER_CODEX_CLI_HOOK: 'true' }, expected: true },
    { env: { AIH_SERVER_CODEX_CLI_HOOK: '0' }, expected: false }
  ];

  cases.forEach(({ env, expected }) => {
    const enabled = isEnvEnabled('AIH_SERVER_CODEX_CLI_HOOK', true, env);
    assert.equal(captureCodexCliHookFlag(enabled), expected);
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
    applyAihFrpConfig: async () => ({ ok: true }),
    discoverFrpcConfigPath: () => '/tmp/frpc.toml',
    reconcileAihFrpConfig: async () => ({ ok: true }),
    removeAihFrpConfig: async () => ({ ok: true }),
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
  assert.equal(calls.localRuntimeArg.startLocalServerDeps.applyAihFrpConfig, deps.applyAihFrpConfig);
  assert.equal(calls.localRuntimeArg.startLocalServerDeps.discoverFrpcConfigPath, deps.discoverFrpcConfigPath);
  assert.equal(calls.localRuntimeArg.startLocalServerDeps.reconcileAihFrpConfig, deps.reconcileAihFrpConfig);
  assert.equal(calls.localRuntimeArg.startLocalServerDeps.removeAihFrpConfig, deps.removeAihFrpConfig);
  assert.equal(calls.localRuntimeArg.startLocalServerDeps.connectFabricBroker, deps.connectFabricBroker);
  assert.equal(typeof calls.localRuntimeArg.startLocalServerDeps.resolveCliPath, 'function');
});
