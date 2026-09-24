'use strict';

// 真实 startLocalServer 的测试夹具：进程替身、最小依赖集与 serve 选项。
// 依赖默认全部替身化（spawn 抛错、fetch 404），需要真实子进程的测试按需 override。

const { EventEmitter } = require('node:events');
const fs = require('fs-extra');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');

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
    restorePersistedZcodeEgress: async () => ({ restored: 0 }),
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
    providerCliAutoUpgrade: false,
    logRequests: false,
    ...extra
  };
}

module.exports = {
  createProcessCapture,
  createServeOptions,
  createServerDeps,
  getFreePort
};
