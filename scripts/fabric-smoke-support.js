'use strict';

const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('fs-extra');

const { startLocalServer } = require('../lib/server/server');
const { createControlPlaneDeviceInvite } = require('../lib/server/control-plane-device-pairing');

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
    logFile: path.join(aiHomeDir, 'server.log'),
    entryFilePath: path.join(process.cwd(), 'bin', 'ai-home.js'),
    nodeExecPath: process.execPath,
    getToolAccountIds: () => [],
    getToolConfigDir: (provider, accountId) => path.join(aiHomeDir, 'profiles', String(provider || ''), String(accountId || '')),
    getProfileDir: (provider, accountId) => path.join(aiHomeDir, 'profiles', String(provider || ''), String(accountId || '')),
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
  const scopes = Array.isArray(options.scopes) && options.scopes.length > 0
    ? options.scopes
    : ['control-plane:read', 'nodes:read'];

  const invite = createControlPlaneDeviceInvite({
    name: options.name || 'Fabric Smoke',
    controlEndpoint,
    scopes
  }, { fs, aiHomeDir });

  await startLocalServer({
    host: '127.0.0.1',
    port,
    provider: 'codex',
    backend: 'openai',
    strategy: 'round_robin',
    codexClientVersion: options.codexClientVersion || '0.0.0-smoke',
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
    invite,
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
