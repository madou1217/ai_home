'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  appServerSocketName,
  appServerStatePath,
  ensureCodexAppServerEndpoint,
  readAppServerState,
  writeAppServerState,
  waitForAppServerReady
} = require('../lib/server/codex-app-server-endpoint');

test('app-server readiness returns as soon as readyz succeeds', async () => {
  let livenessChecks = 0;

  await waitForAppServerReady(9527, 'aih-codexapp-test', {
    checkReadyz: async () => true,
    hasRunSession: () => {
      livenessChecks += 1;
      return true;
    }
  });

  assert.equal(livenessChecks, 0);
});

test('app-server readiness fails immediately when the tmux process exits', async () => {
  let delayCalls = 0;
  const multiplexerBinding = { name: 'herdr' };

  await assert.rejects(
    waitForAppServerReady(9527, 'aih-codexapp-test', {
      checkReadyz: async () => false,
      hasRunSession: (_socket, options) => {
        assert.strictEqual(options.multiplexerBinding, multiplexerBinding);
        return false;
      },
      multiplexerBinding,
      delay: async () => {
        delayCalls += 1;
      },
      logPath: '/tmp/codex-app-server.log'
    }),
    (error) => error.code === 'codex_app_server_process_exited'
      && error.message.includes('/tmp/codex-app-server.log')
  );
  assert.equal(delayCalls, 0);
});

test('app-server state: persists Herdr, defaults legacy state to tmux, rejects unknown backend', (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-app-state-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  const written = writeAppServerState(aiHomeDir, 'gateway', {
    gateway: true,
    runtimeScope: 'gateway',
    multiplexer: 'herdr',
    port: 43123,
    socket: 'aih-codexapp-gateway'
  });
  assert.equal(written.multiplexer, 'herdr');
  assert.equal(readAppServerState(aiHomeDir, 'gateway').multiplexer, 'herdr');

  fs.writeFileSync(appServerStatePath(aiHomeDir, 'gateway'), JSON.stringify({
    gateway: true,
    runtimeScope: 'gateway',
    port: 43123,
    socket: 'aih-codexapp-gateway'
  }));
  assert.equal(readAppServerState(aiHomeDir, 'gateway').multiplexer, 'tmux');

  fs.writeFileSync(appServerStatePath(aiHomeDir, 'gateway'), JSON.stringify({
    gateway: true,
    runtimeScope: 'gateway',
    multiplexer: 'unknown',
    port: 43123,
    socket: 'aih-codexapp-gateway'
  }));
  assert.equal(readAppServerState(aiHomeDir, 'gateway').multiplexer, '');
});

test('app-server lifecycle: cleans legacy tmux, binds new Herdr, and persists backend before readiness', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-app-binding-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const socket = appServerSocketName('gateway');
  writeAppServerState(aiHomeDir, 'gateway', {
    gateway: true,
    runtimeScope: 'gateway',
    multiplexer: 'tmux',
    port: 43000,
    socket,
    startedAt: 1
  });

  const calls = [];
  const spawnSyncImpl = (command, args) => {
    calls.push([command, args]);
    if (command === 'tmux' && args[0] === '-V') return { status: 0 };
    if (command === 'tmux' && args.includes('kill-server')) return { status: 0 };
    if (command === 'herdr' && args[0] === '--version') return { status: 0 };
    if (command === 'herdr' && args[0] === 'spawn') return { status: 0 };
    return { status: 1 };
  };
  let readyChecks = 0;
  const result = await ensureCodexAppServerEndpoint({
    gateway: true,
    aiHomeDir,
    env: {},
    getProfileDir: () => aiHomeDir,
    runtimeExecutablePath: '/usr/bin/codex',
    buildProviderEnvImpl: () => ({ HOME: aiHomeDir }),
    pickFreePortImpl: async () => 43123,
    checkReadyzImpl: async () => {
      readyChecks += 1;
      if (readyChecks === 1) return false;
      assert.equal(readAppServerState(aiHomeDir, 'gateway').multiplexer, 'herdr');
      return true;
    },
    spawnSyncImpl
  });

  assert.deepEqual(result, { port: 43123, reused: false });
  const tmuxKillIndex = calls.findIndex(([command, args]) => command === 'tmux' && args.includes('kill-server'));
  const herdrSpawnIndex = calls.findIndex(([command, args]) => command === 'herdr' && args[0] === 'spawn');
  assert.ok(tmuxKillIndex >= 0);
  assert.ok(herdrSpawnIndex > tmuxKillIndex);
  assert.equal(readAppServerState(aiHomeDir, 'gateway').multiplexer, 'herdr');
});

test('app-server lifecycle: unknown persisted backend fails closed', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-app-invalid-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  fs.mkdirSync(path.dirname(appServerStatePath(aiHomeDir, 'gateway')), { recursive: true });
  fs.writeFileSync(appServerStatePath(aiHomeDir, 'gateway'), JSON.stringify({
    gateway: true,
    runtimeScope: 'gateway',
    multiplexer: 'unknown',
    socket: appServerSocketName('gateway')
  }));

  await assert.rejects(
    ensureCodexAppServerEndpoint({
      gateway: true,
      aiHomeDir,
      getProfileDir: () => aiHomeDir,
      checkReadyzImpl: async () => false,
      spawnSyncImpl: () => {
        throw new Error('invalid state must fail before probing any backend');
      }
    }),
    (error) => error.code === 'codex_app_server_state_invalid'
  );
  assert.ok(fs.existsSync(appServerStatePath(aiHomeDir, 'gateway')));
});

test('app-server lifecycle: healthy endpoint cannot bypass unknown persisted backend', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-app-invalid-healthy-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  fs.mkdirSync(path.dirname(appServerStatePath(aiHomeDir, 'gateway')), { recursive: true });
  fs.writeFileSync(appServerStatePath(aiHomeDir, 'gateway'), JSON.stringify({
    gateway: true,
    runtimeScope: 'gateway',
    multiplexer: 'unknown',
    port: 43123,
    socket: appServerSocketName('gateway')
  }));

  await assert.rejects(
    ensureCodexAppServerEndpoint({
      gateway: true,
      aiHomeDir,
      getProfileDir: () => aiHomeDir,
      checkReadyzImpl: async () => true,
      spawnSyncImpl: () => {
        throw new Error('invalid state must fail before probing any backend');
      }
    }),
    (error) => error.code === 'codex_app_server_state_invalid'
  );
  assert.ok(fs.existsSync(appServerStatePath(aiHomeDir, 'gateway')));
});

test('app-server readiness preserves the bounded timeout for a live process', async () => {
  let timestamp = 0;

  await assert.rejects(
    waitForAppServerReady(9527, 'aih-codexapp-test', {
      timeoutMs: 2,
      pollIntervalMs: 0,
      now: () => timestamp++,
      checkReadyz: async () => false,
      hasRunSession: () => true,
      delay: async () => {}
    }),
    (error) => error.code === 'codex_app_server_not_ready'
      && error.message.includes('2ms')
  );
});
