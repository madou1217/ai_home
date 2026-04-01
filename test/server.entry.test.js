const test = require('node:test');
const assert = require('node:assert/strict');
const { runServerEntry } = require('../lib/server/entry');

test('runServerEntry wires start/sync delegates into runServerCommand', async () => {
  let seenStart = false;
  let seenSync = false;
  const fakeRunProxyCommand = async (_args, deps) => {
    assert.equal(typeof deps.startLocalServer, 'function');
    assert.equal(typeof deps.syncCodexAccountsToServer, 'function');

    const syncResult = await deps.syncCodexAccountsToServer({ dryRun: true });
    assert.equal(syncResult.ok, true);
    seenSync = true;

    const startResult = await deps.startLocalServer({ port: 1 });
    assert.equal(startResult.ok, true);
    seenStart = true;

    return 0;
  };

  const code = await runServerEntry(['server'], {
    fs: {},
    fetchImpl: async () => ({ ok: true }),
    http: {},
    processObj: { cwd: () => '/' },
    logFile: '/tmp/x.log',
    getToolAccountIds: () => [],
    getToolConfigDir: () => '',
    getProfileDir: () => '',
    checkStatus: () => ({ configured: false }),
    syncCodexAccountsToServer: async () => ({ ok: true }),
    startLocalServerModule: async () => ({ ok: true }),
    runServerCommand: fakeRunProxyCommand,
    showServerUsage: () => {},
    serverDaemon: {},
    parseServerSyncArgs: () => ({}),
    parseServerServeArgs: () => ({}),
    parseServerEnvArgs: () => ({})
  });

  assert.equal(code, 0);
  assert.equal(seenSync, true);
  assert.equal(seenStart, true);
});

test('runServerEntry forwards daemon and parser contracts for serve control actions', async () => {
  const fakeDaemon = { restart: async () => ({ running: true }) };
  const fakeRunProxyCommand = async (_args, deps) => {
    assert.equal(deps.serverDaemon, fakeDaemon);
    assert.equal(typeof deps.parseServerSyncArgs, 'function');
    assert.equal(typeof deps.parseServerServeArgs, 'function');
    assert.equal(typeof deps.parseServerEnvArgs, 'function');
    return 0;
  };

  const code = await runServerEntry(['server', 'restart'], {
    fs: {},
    fetchImpl: async () => ({ ok: true }),
    http: {},
    processObj: { cwd: () => '/' },
    logFile: '/tmp/x.log',
    getToolAccountIds: () => [],
    getToolConfigDir: () => '',
    getProfileDir: () => '',
    checkStatus: () => ({ configured: false }),
    syncCodexAccountsToServer: async () => ({ ok: true }),
    startLocalServerModule: async () => ({ ok: true }),
    runServerCommand: fakeRunProxyCommand,
    showServerUsage: () => {},
    serverDaemon: fakeDaemon,
    parseServerSyncArgs: () => ({}),
    parseServerServeArgs: () => ({}),
    parseServerEnvArgs: () => ({})
  });

  assert.equal(code, 0);
});

test('runServerEntry forwards parse helpers and daemon controller for serve-control flows', async () => {
  const parsed = [];
  const fakeRunProxyCommand = async (_args, deps) => {
    parsed.push(deps.parseServerSyncArgs(['--dry-run']));
    parsed.push(deps.parseServerServeArgs(['--port', '8321']));
    parsed.push(deps.parseServerEnvArgs(['--api-key', 'x']));
    assert.equal(typeof deps.serverDaemon, 'object');
    assert.equal(typeof deps.showServerUsage, 'function');
    return 0;
  };

  const code = await runServerEntry(['server', 'serve'], {
    fs: {},
    fetchImpl: async () => ({ ok: true }),
    http: {},
    processObj: { cwd: () => '/' },
    logFile: '/tmp/x.log',
    getToolAccountIds: () => [],
    getToolConfigDir: () => '',
    getProfileDir: () => '',
    checkStatus: () => ({ configured: false }),
    syncCodexAccountsToServer: async () => ({ ok: true }),
    startLocalServerModule: async () => ({ ok: true }),
    runServerCommand: fakeRunProxyCommand,
    showServerUsage: () => {},
    serverDaemon: { restart: () => ({ ok: true }) },
    parseServerSyncArgs: (args) => ({ kind: 'sync', args }),
    parseServerServeArgs: (args) => ({ kind: 'serve', args }),
    parseServerEnvArgs: (args) => ({ kind: 'env', args })
  });

  assert.equal(code, 0);
  assert.deepEqual(parsed, [
    { kind: 'sync', args: ['--dry-run'] },
    { kind: 'serve', args: ['--port', '8321'] },
    { kind: 'env', args: ['--api-key', 'x'] }
  ]);
});
