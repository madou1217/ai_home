'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('fs-extra');

const { startLocalServer } = require('../lib/server/server');
const {
  resolveAccountRuntimeDir,
  resolveAihLogPath
} = require('../lib/runtime/aih-storage-layout');

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      server.close((error) => {
        if (error) return reject(error);
        resolve(port);
      });
    });
    server.once('error', reject);
  });
}

function createProcessCapture(argv = ['node', 'scripts/fabric-smoke-support.js']) {
  const handlers = {};
  let resolveExit = null;
  const exited = new Promise((resolve) => { resolveExit = resolve; });
  return {
    env: {
      ...process.env,
      AIH_SERVER_DISABLE_SOURCE_AUTO_RESTART: '1'
    },
    argv,
    execPath: process.execPath,
    pid: process.pid,
    cwd: () => process.cwd(),
    once(signal, handler) {
      handlers[signal] = handler;
    },
    exit(code) {
      resolveExit(code);
    },
    stop(signal = 'SIGTERM') {
      if (typeof handlers[signal] === 'function') {
        handlers[signal](signal);
        return exited;
      }
      resolveExit(0);
      return exited;
    }
  };
}

function createServerDeps(aiHomeDir, processObj, overrides = {}) {
  return {
    http,
    fs,
    aiHomeDir,
    hostHomeDir: aiHomeDir,
    processObj,
    spawn,
    spawnSync,
    path,
    resolveCliPath: () => '',
    logFile: resolveAihLogPath(aiHomeDir, 'server.log'),
    entryFilePath: path.join(process.cwd(), 'bin', 'ai-home.js'),
    nodeExecPath: process.execPath,
    getToolAccountIds: () => [],
    getToolConfigDir: (provider, accountRef) => resolveAccountRuntimeDir(aiHomeDir, provider, accountRef),
    getProfileDir: (provider, accountRef) => resolveAccountRuntimeDir(aiHomeDir, provider, accountRef),
    checkStatus: () => ({ configured: false }),
    getLastUsageProbeError: () => '',
    getLastUsageProbeState: () => ({}),
    ensureUsageSnapshotAsync: async () => null,
    getProjectsSnapshot: async () => ({ projects: [] }),
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
    relaySessionRegistry: {
      closeAll() {}
    },
    ...overrides
  };
}

async function startFabricSmokeServer(options = {}) {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), options.dirPrefix || 'aih-fabric-smoke-'));
  const port = await getFreePort();
  const controlEndpoint = `http://127.0.0.1:${port}`;
  const processObj = createProcessCapture(options.argv);
  const managementKey = String(options.managementKey || crypto.randomBytes(24).toString('hex')).trim();

  await startLocalServer({
    host: '127.0.0.1',
    port,
    provider: 'codex',
    backend: 'openai',
    strategy: 'round_robin',
    codexClientVersion: options.codexClientVersion || '0.0.0-smoke',
    managementKey,
    modelUsageScan: false,
    logRequests: false,
    ...(options.serverOptions || {})
  }, createServerDeps(aiHomeDir, processObj, options.deps || {}));

  const cleanup = async () => {
    try {
      await processObj.stop();
    } catch (_error) {}
    try {
      fs.rmSync(aiHomeDir, { recursive: true, force: true });
    } catch (_error) {}
  };

  return {
    aiHomeDir,
    port,
    controlEndpoint,
    endpoint: controlEndpoint,
    managementKey,
    processObj,
    cleanup
  };
}

module.exports = {
  createProcessCapture,
  createServerDeps,
  getFreePort,
  startFabricSmokeServer
};
