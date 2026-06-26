const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('fs-extra');

const { startLocalServer } = require('../lib/server/server');
const {
  consumeControlPlaneDeviceInvite,
  createControlPlaneDeviceInvite
} = require('../lib/server/control-plane-device-pairing');
const { upsertRemoteNode } = require('../lib/server/remote/node-registry');
const { upsertRemoteTransport } = require('../lib/server/remote/transport-registry');

async function getFreePort() {
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

function createProcessCapture() {
  const handlers = {};
  let resolveExit = null;
  const exited = new Promise((resolve) => { resolveExit = resolve; });
  return {
    env: {
      AIH_SERVER_DISABLE_SOURCE_AUTO_RESTART: '1'
    },
    argv: ['node', 'bin/ai-home.js', 'server', 'serve'],
    execPath: process.execPath,
    pid: process.pid,
    cwd: () => process.cwd(),
    once(signal, handler) {
      handlers[signal] = handler;
    },
    exit(code) {
      resolveExit(code);
    },
    async stop(signal = 'SIGTERM') {
      if (typeof handlers[signal] === 'function') {
        handlers[signal](signal);
        return exited;
      }
      return undefined;
    }
  };
}

function createServerDeps(aiHomeDir, processObj, relaySessionRegistry) {
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
    relaySessionRegistry
  };
}

function seedPairedDeviceNode(aiHomeDir, controlEndpoint, scopes = ['nodes:read']) {
  const node = upsertRemoteNode({
    id: 'home-win',
    name: 'Home Windows',
    capabilities: ['status', 'sessions'],
    preferredTransports: ['relay']
  }, { fs, aiHomeDir });
  upsertRemoteTransport({
    id: 'home-win-relay',
    nodeId: node.id,
    kind: 'relay',
    status: 'up',
    score: 55,
    provider: 'aih-relay',
    routeRole: 'data-plane',
    trustLevel: 'managed'
  }, { fs, aiHomeDir });

  const invite = createControlPlaneDeviceInvite({
    name: 'Phone',
    controlEndpoint,
    scopes
  }, { fs, aiHomeDir });
  return consumeControlPlaneDeviceInvite({
    code: invite.code,
    device: { name: 'Phone', platform: 'ios' }
  }, { fs, aiHomeDir });
}

test('server node-rpc device nodes uses shared relay registry for mobile status', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-server-node-rpc-'));
  const port = await getFreePort();
  const controlEndpoint = `http://127.0.0.1:${port}`;
  const paired = seedPairedDeviceNode(aiHomeDir, controlEndpoint);
  const processObj = createProcessCapture();
  const relaySessionRegistry = {
    getRelaySession(nodeId) {
      if (nodeId !== 'home-win') return null;
      return {
        sessionId: 'relay-session-1',
        nodeId: 'home-win',
        transportId: 'home-win-relay',
        remoteAddress: '203.0.113.10',
        connectedAt: 1000,
        lastSeenAt: 2000
      };
    },
    closeAll() {}
  };

  t.after(async () => {
    await processObj.stop();
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  });

  await startLocalServer({
    host: '127.0.0.1',
    port,
    provider: 'codex',
    backend: 'openai',
    strategy: 'round_robin',
    codexClientVersion: '0.0.0-test',
    modelUsageScan: false,
    logRequests: false
  }, createServerDeps(aiHomeDir, processObj, relaySessionRegistry));

  const response = await fetch(`${controlEndpoint}/v0/node-rpc/device-nodes`, {
    headers: {
      authorization: `Bearer ${paired.token}`
    }
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.result.nodes.length, 1);
  assert.equal(payload.result.nodes[0].id, 'home-win');
  assert.equal(payload.result.nodes[0].connection.status, 'online');
  assert.equal(payload.result.nodes[0].connection.transportKind, 'relay');
  assert.equal(payload.result.nodes[0].connection.transportId, 'home-win-relay');
  assert.equal(payload.result.nodes[0].connection.sessionId, 'relay-session-1');
  assert.equal(payload.result.nodes[0].connection.lastSeenAt, 2000);
});

test('server node-rpc device node sessions wires relay management dependency', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-server-node-rpc-sessions-'));
  const port = await getFreePort();
  const controlEndpoint = `http://127.0.0.1:${port}`;
  const paired = seedPairedDeviceNode(aiHomeDir, controlEndpoint, ['nodes:read', 'sessions:read']);
  const processObj = createProcessCapture();
  const relaySessionRegistry = {
    getRelaySession() {
      return null;
    },
    closeAll() {}
  };

  t.after(async () => {
    await processObj.stop();
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  });

  await startLocalServer({
    host: '127.0.0.1',
    port,
    provider: 'codex',
    backend: 'openai',
    strategy: 'round_robin',
    codexClientVersion: '0.0.0-test',
    modelUsageScan: false,
    logRequests: false
  }, createServerDeps(aiHomeDir, processObj, relaySessionRegistry));

  const response = await fetch(`${controlEndpoint}/v0/node-rpc/device-node-sessions?nodeId=home-win`, {
    headers: {
      authorization: `Bearer ${paired.token}`
    }
  });
  assert.equal(response.status, 503);
  const payload = await response.json();
  assert.equal(payload.ok, false);
  assert.equal(payload.error, 'remote_relay_session_unavailable');
});
