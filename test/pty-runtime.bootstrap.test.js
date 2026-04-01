const test = require('node:test');
const assert = require('node:assert/strict');
const { createPtyRuntimeDeps } = require('../lib/cli/bootstrap/pty-runtime');

test('createPtyRuntimeDeps forwards required runtime handlers', () => {
  const resolveCliPath = () => '/bin/codex';
  const buildPtyLaunch = () => ({});
  const resolveWindowsBatchLaunch = () => ({});
  const spawn = () => ({});
  const deps = createPtyRuntimeDeps({
    path: {},
    fs: {},
    processObj: {},
    pty: {},
    spawn,
    execSync: () => '',
    resolveCliPath,
    buildPtyLaunch,
    resolveWindowsBatchLaunch,
    readUsageConfig: () => ({}),
    cliConfigs: {},
    aiHomeDir: '/tmp/aih',
    getProfileDir: () => '',
    askYesNo: () => true,
    stripAnsi: (s) => s,
    ensureSessionStoreLinks: () => {},
    ensureUsageSnapshot: async () => ({}),
    ensureUsageSnapshotAsync: async () => ({}),
    readUsageCache: () => null,
    getUsageRemainingPercentValues: () => [],
    getNextAvailableId: () => 1,
    markActiveAccount: () => {},
    ensureAccountUsageRefreshScheduler: () => {},
    refreshIndexedStateForAccount: () => {}
  });

  assert.equal(deps.resolveCliPath, resolveCliPath);
  assert.equal(deps.buildPtyLaunch, buildPtyLaunch);
  assert.equal(deps.resolveWindowsBatchLaunch, resolveWindowsBatchLaunch);
  assert.equal(deps.spawn, spawn);
  assert.equal(deps.aiHomeDir, '/tmp/aih');
  assert.equal(typeof deps.ensureUsageSnapshotAsync, 'function');
});
