'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('fs-extra');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const { startLocalServer } = require('../lib/server/server');

async function getFreePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const address = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return address.port;
}

function createProcessCapture() {
  const processObj = new EventEmitter();
  processObj.env = { AIH_SERVER_DISABLE_SOURCE_AUTO_RESTART: '1' };
  processObj.argv = ['node', 'bin/ai-home.js', '__background', 'run'];
  processObj.execPath = process.execPath;
  processObj.pid = process.pid;
  processObj.cwd = () => process.cwd();
  processObj.kill = (pid) => {
    if (Number(pid) === process.pid) return true;
    const error = new Error('ESRCH');
    error.code = 'ESRCH';
    throw error;
  };
  processObj.exitCalls = [];
  processObj.exit = (code) => processObj.exitCalls.push(code);
  return processObj;
}

function createServerDeps(aiHomeDir, processObj, lifecycle, overrides = {}) {
  const sessionEventBus = new EventEmitter();
  sessionEventBus.off = sessionEventBus.off.bind(sessionEventBus);
  return {
    http,
    fs,
    path,
    aiHomeDir,
    hostHomeDir: aiHomeDir,
    processObj,
    spawn() {
      throw new Error('unexpected_spawn');
    },
    spawnSync() {
      return { status: 1, stdout: '', stderr: '' };
    },
    resolveCliPath: () => '',
    logFile: path.join(aiHomeDir, 'logs', 'server.log'),
    entryFilePath: path.join(process.cwd(), 'bin', 'ai-home.js'),
    nodeExecPath: process.execPath,
    getToolConfigDir: () => '',
    getProfileDir: () => '',
    checkStatus: () => ({ configured: false }),
    getLastUsageProbeError: () => '',
    getLastUsageProbeState: () => ({}),
    ensureUsageSnapshotAsync: async () => null,
    codexAuthInvalidReconciler: null,
    fetchImpl: async () => ({
      ok: false,
      status: 404,
      text: async () => JSON.stringify({ ok: false, error: 'not_found' })
    }),
    ensureSessionStoreLinks: () => {},
    syncGlobalConfigToHost: () => {},
    accountArtifactHooks: {},
    enableCodexDesktopAppHook: false,
    enableCodexCliHook: false,
    loadServerRuntimeAccounts: () => ({}),
    applyReloadState: () => {},
    sessionEventBus,
    relaySessionRegistry: {
      closeAll() { lifecycle.relayClosed += 1; }
    },
    webrtcSessionRegistry: {
      closeAll() { lifecycle.webrtcClosed += 1; }
    },
    fabricBrokerSessionRegistry: {
      closeAll() { lifecycle.fabricClosed += 1; }
    },
    startServerMdnsDiscovery: async () => ({
      identity: { id: 'server-lifecycle-test', name: 'Lifecycle Test' },
      stop() { lifecycle.mdnsStopped += 1; }
    }),
    readOutboundRelayConfig: () => ({ version: 1, relays: [] }),
    createOutboundRelayManager: () => ({
      async start() {},
      async stop() {
        await new Promise((resolve) => setImmediate(resolve));
        lifecycle.outboundStopped += 1;
      },
      getSnapshot: () => ({ running: true, relays: [] })
    }),
    startFrpConfigReconcileLoop: () => ({
      stop() { lifecycle.frpStopped += 1; }
    }),
    restorePersistentSessions: () => ({ restored: 0 }),
    setInterval(callback, delay) {
      const timer = { callback, delay, unref() {} };
      lifecycle.logTimers.add(timer);
      return timer;
    },
    clearInterval(timer) {
      if (lifecycle.logTimers.delete(timer)) lifecycle.logTimersCleared += 1;
    },
    ...overrides
  };
}

function createServeOptions(port, extra = {}) {
  return {
    host: '127.0.0.1',
    port,
    provider: 'codex',
    backend: 'codex-adapter',
    strategy: 'random',
    codexClientVersion: '0.0.0-test',
    managementKey: 'management-key-that-is-long-enough',
    modelUsageScan: false,
    logRequests: false,
    ...extra
  };
}

test('embedded local server returns an idempotent lifecycle handle without owning process exit', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-server-lifecycle-'));
  const processObj = createProcessCapture();
  const lifecycle = {
    relayClosed: 0,
    webrtcClosed: 0,
    fabricClosed: 0,
    mdnsStopped: 0,
    outboundStopped: 0,
    frpStopped: 0,
    logTimers: new Set(),
    logTimersCleared: 0
  };
  const port = await getFreePort();
  let handle = null;

  t.after(async () => {
    if (handle && typeof handle.stop === 'function') {
      await handle.stop('test-cleanup');
    } else if (processObj.listenerCount('SIGTERM') > 0) {
      processObj.emit('SIGTERM');
    }
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  });

  handle = await startLocalServer(
    createServeOptions(port, { manageProcessLifecycle: false }),
    createServerDeps(aiHomeDir, processObj, lifecycle)
  );

  assert.equal(handle.server.listening, true);
  assert.deepEqual(handle.address, { host: '127.0.0.1', port });
  assert.equal(typeof handle.stop, 'function');
  assert.equal(typeof handle.closed.then, 'function');
  assert.equal(processObj.listenerCount('SIGINT'), 0);
  assert.equal(processObj.listenerCount('SIGTERM'), 0);

  const firstStop = handle.stop('test');
  const secondStop = handle.stop('duplicate');
  assert.strictEqual(secondStop, firstStop);
  await firstStop;
  await handle.closed;

  assert.deepEqual(processObj.exitCalls, []);
  assert.equal(handle.server.listening, false);
  assert.equal(lifecycle.relayClosed, 1);
  assert.equal(lifecycle.webrtcClosed, 1);
  assert.equal(lifecycle.fabricClosed, 1);
  assert.equal(lifecycle.mdnsStopped, 1);
  assert.equal(lifecycle.outboundStopped, 1);
  assert.equal(lifecycle.frpStopped, 1);
  assert.equal(lifecycle.logTimersCleared, 1);
  assert.equal(processObj.listenerCount('exit'), 0);
  assert.equal(fs.existsSync(path.join(aiHomeDir, 'run', 'server.pid')), false);
});

test('server creates one chat runtime, injects it into WebUI, and closes it on stop', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-server-chat-runtime-'));
  const processObj = createProcessCapture();
  const lifecycle = createLifecycleCapture();
  const port = await getFreePort();
  const service = {
    closed: 0,
    listCalls: 0,
    listSessions() {
      this.listCalls += 1;
      return [{ sessionId: 'chat-session-1' }];
    },
    close() { this.closed += 1; }
  };
  const compositions = [];
  let handle;
  const serverDeps = createServerDeps(aiHomeDir, processObj, lifecycle, {
    createChatRuntimeComposition(options) {
      compositions.push(options);
      return service;
    }
  });
  t.after(async () => {
    if (handle) await handle.stop('test-cleanup');
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  });

  handle = await startLocalServer(
    createServeOptions(port, { manageProcessLifecycle: false }),
    serverDeps
  );
  for (let request = 0; request < 2; request += 1) {
    const response = await fetch(`http://127.0.0.1:${port}/v0/webui/chat/sessions`, {
      headers: { authorization: 'Bearer management-key-that-is-long-enough' }
    });
    assert.equal(response.status, 200, await response.text());
  }

  assert.equal(compositions.length, 1);
  assert.strictEqual(compositions[0].aiHomeDir, aiHomeDir);
  assert.strictEqual(compositions[0].getProfileDir, serverDeps.getProfileDir);
  assert.strictEqual(compositions[0].env, processObj.env);
  assert.strictEqual(compositions[0].spawnSync, serverDeps.spawnSync);
  assert.strictEqual(compositions[0].accountArtifactHooks, serverDeps.accountArtifactHooks);
  assert.equal(typeof compositions[0].appendServerLog, 'function');
  assert.equal(service.listCalls, 2);
  await handle.stop('test');
  assert.equal(service.closed, 1);
});

test('server stays available when chat runtime storage is unsupported', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-server-chat-runtime-unavailable-'));
  const processObj = createProcessCapture();
  const lifecycle = createLifecycleCapture();
  const port = await getFreePort();
  let handle;
  t.after(async () => {
    if (handle) await handle.stop('test-cleanup');
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  });

  handle = await startLocalServer(
    createServeOptions(port, { manageProcessLifecycle: false }),
    createServerDeps(aiHomeDir, processObj, lifecycle, {
      createChatRuntimeComposition() {
        const error = new Error('chat_runtime_database_unavailable');
        error.code = 'chat_runtime_database_unavailable';
        throw error;
      }
    })
  );
  const response = await fetch(`http://127.0.0.1:${port}/v0/webui/chat/sessions`, {
    headers: { authorization: 'Bearer management-key-that-is-long-enough' }
  });

  assert.equal(handle.server.listening, true);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, 'chat_runtime_unavailable');
});

test('foreground local server keeps signal-driven process exit behavior', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-server-foreground-lifecycle-'));
  const processObj = createProcessCapture();
  const lifecycle = {
    relayClosed: 0,
    webrtcClosed: 0,
    fabricClosed: 0,
    mdnsStopped: 0,
    outboundStopped: 0,
    frpStopped: 0,
    logTimers: new Set(),
    logTimersCleared: 0
  };
  const port = await getFreePort();
  let handle = null;

  t.after(async () => {
    if (handle && handle.server.listening) await handle.stop('test-cleanup');
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  });

  handle = await startLocalServer(
    createServeOptions(port),
    createServerDeps(aiHomeDir, processObj, lifecycle)
  );

  assert.equal(processObj.listenerCount('SIGINT'), 1);
  assert.equal(processObj.listenerCount('SIGTERM'), 1);
  processObj.emit('SIGTERM');
  await handle.closed;
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(processObj.exitCalls, [0]);
  assert.equal(processObj.listenerCount('SIGINT'), 0);
  assert.equal(processObj.listenerCount('SIGTERM'), 0);
});

function createLifecycleCapture() {
  return {
    relayClosed: 0,
    webrtcClosed: 0,
    fabricClosed: 0,
    mdnsStopped: 0,
    outboundStopped: 0,
    frpStopped: 0,
    logTimers: new Set(),
    logTimersCleared: 0
  };
}
