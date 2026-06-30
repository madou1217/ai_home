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
const { runFabricTransportEcho } = require('../lib/cli/services/fabric/transport-echo');

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

function createServerDeps(aiHomeDir, processObj, relaySessionRegistry, overrides = {}) {
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
    relaySessionRegistry,
    ...overrides
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

test('server fabric descriptor and device pair endpoints support server setup onboarding', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-server-fabric-'));
  const port = await getFreePort();
  const controlEndpoint = `http://127.0.0.1:${port}`;
  const processObj = createProcessCapture();
  const relaySessionRegistry = { closeAll() {} };
  const invite = createControlPlaneDeviceInvite({
    name: 'Phone',
    controlEndpoint,
    scopes: ['control-plane:read', 'nodes:read']
  }, { fs, aiHomeDir });

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

  const descriptorResponse = await fetch(`${controlEndpoint}/v0/fabric/descriptor`);
  assert.equal(descriptorResponse.status, 200);
  const descriptor = await descriptorResponse.json();
  assert.equal(descriptor.ok, true);
  assert.equal(descriptor.rpc, 'fabric.descriptor.read');
  assert.equal(descriptor.result.service, 'aih-fabric');
  assert.equal(descriptor.result.server.endpoint, controlEndpoint);
  assert.deepEqual(descriptor.result.auth.methods, ['device-pair']);
  assert.equal(descriptor.result.capabilities.legacyControlPlane.nodeRpc.includes('device-pair'), true);
  assert.equal(descriptor.result.capabilities.client.includes('role-registry'), true);
  assert.equal(descriptor.result.capabilities.roles.server.includes('role-registry'), true);
  assert.equal(descriptor.result.capabilities.transportLab.includes('webrtc-signaling'), true);
  assert.equal(descriptor.result.capabilities.transportLab.includes('ws-echo'), true);
  assert.equal(descriptor.result.capabilities.transports.includes('webrtc-datachannel-lab'), true);
  assert.equal(descriptor.result.capabilities.transports.includes('ws-echo'), true);

  const redirectResponse = await fetch(invite.pairUrl, { redirect: 'manual' });
  assert.equal(redirectResponse.status, 302);
  assert.match(redirectResponse.headers.get('location') || '', /\/ui\/server-setup\?pair=/);

  const pairResponse = await fetch(`${controlEndpoint}/v0/fabric/device-pair?code=${encodeURIComponent(invite.code)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      device: {
        id: 'device-ios-fabric',
        name: 'iPhone',
        platform: 'ios'
      }
    })
  });
  assert.equal(pairResponse.status, 200);
  const paired = await pairResponse.json();
  assert.equal(paired.ok, true);
  assert.equal(paired.rpc, 'fabric.device.pair');
  assert.equal(paired.result.device.id, 'device-ios-fabric');
  assert.equal(paired.result.fabric.service, 'aih-fabric');
  assert.ok(paired.result.token);
});

test('server fabric transport echo endpoint runs on the existing server listener', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-server-fabric-echo-'));
  const port = await getFreePort();
  const processObj = createProcessCapture();
  const relaySessionRegistry = { closeAll() {} };

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

  const result = await runFabricTransportEcho([
    `ws://127.0.0.1:${port}/v0/fabric/transport/echo`,
    '--count',
    '3',
    '--payload-size',
    '16',
    '--timeout-ms',
    '5000',
    '--json'
  ]);

  assert.equal(result.ok, true);
  assert.equal(result.successes, 3);
  assert.equal(result.failures.length, 0);
  assert.equal(result.rttMs.count, 3);
});

test('server fabric webrtc signaling endpoint exchanges lab messages', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-server-fabric-webrtc-'));
  const port = await getFreePort();
  const controlEndpoint = `http://127.0.0.1:${port}`;
  const processObj = createProcessCapture();
  const relaySessionRegistry = { closeAll() {} };

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

  const createResponse = await fetch(`${controlEndpoint}/v0/fabric/webrtc/signaling/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Node test' })
  });
  assert.equal(createResponse.status, 200);
  const created = await createResponse.json();
  assert.equal(created.ok, true);
  assert.match(created.result.roomId, /^rtc_/);

  const roomId = created.result.roomId;
  const offerResponse = await fetch(`${controlEndpoint}/v0/fabric/webrtc/signaling/rooms/${roomId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      peerId: 'peer-a',
      type: 'offer',
      payload: { type: 'offer', sdp: 'v=0' }
    })
  });
  assert.equal(offerResponse.status, 200);
  const offer = await offerResponse.json();
  assert.equal(offer.result.seq, 1);

  const listResponse = await fetch(`${controlEndpoint}/v0/fabric/webrtc/signaling/rooms/${roomId}/messages?since=0`);
  assert.equal(listResponse.status, 200);
  const listed = await listResponse.json();
  assert.equal(listed.ok, true);
  assert.equal(listed.result.messages.length, 1);
  assert.equal(listed.result.messages[0].type, 'offer');
  assert.equal(listed.result.nextSeq, 1);

  const missingResponse = await fetch(`${controlEndpoint}/v0/fabric/webrtc/signaling/rooms/rtc_missing/messages`);
  assert.equal(missingResponse.status, 404);
});

test('server fabric registry registers scoped nodes and mirrors node-rpc views', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-server-fabric-registry-'));
  const port = await getFreePort();
  const controlEndpoint = `http://127.0.0.1:${port}`;
  const processObj = createProcessCapture();
  const relaySessionRegistry = { closeAll() {} };
  const invite = createControlPlaneDeviceInvite({
    name: 'Home Mac',
    controlEndpoint,
    scopes: ['nodes:read', 'nodes:write']
  }, { fs, aiHomeDir });
  const paired = consumeControlPlaneDeviceInvite({
    code: invite.code,
    device: {
      id: 'device-home-mac',
      name: 'Home Mac',
      platform: 'darwin'
    }
  }, { fs, aiHomeDir });

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

  const unauthenticated = await fetch(`${controlEndpoint}/v0/fabric/registry/nodes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ node: { id: 'home-mac' } })
  });
  assert.equal(unauthenticated.status, 401);

  const registerResponse = await fetch(`${controlEndpoint}/v0/fabric/registry/nodes`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${paired.token}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      node: {
        id: 'home-mac',
        name: 'Home Mac',
        roles: ['node', 'relay-node'],
        platform: 'darwin',
        arch: 'arm64',
        machineFingerprint: 'raw-hardware-id',
        capabilities: ['projects', 'sessions']
      },
      relayNode: {
        capacityClass: 'tiny',
        bandwidthLimitKbps: 2048
      },
      transports: [
        { id: 'home-mac-relay', kind: 'relay', health: 'up' }
      ],
      projects: [
        { path: '/Users/model/projects/feature/ai_home', name: 'ai_home', vcs: 'git', permissions: ['read', 'write'] }
      ],
      runtimes: [
        { provider: 'codex', mode: 'tui', version: '0.142.0' }
      ]
    })
  });
  assert.equal(registerResponse.status, 200);
  const registered = await registerResponse.json();
  assert.equal(registered.ok, true);
  assert.equal(registered.rpc, 'fabric.registry.node.register');
  assert.equal(registered.result.node.ownerDeviceId, 'device-home-mac');
  assert.deepEqual(registered.result.node.roles, ['node', 'relay-node']);
  assert.match(registered.result.node.machineFingerprintHash, /^sha256:/);
  assert.doesNotMatch(JSON.stringify(registered.result.registry), /raw-hardware-id/);
  assert.equal(registered.result.registry.counts.nodes, 1);
  assert.equal(registered.result.registry.counts.projects, 1);
  assert.equal(registered.result.registry.counts.runtimes, 1);
  assert.equal(registered.result.registry.counts.relayNodes, 1);

  const heartbeatResponse = await fetch(`${controlEndpoint}/v0/fabric/registry/heartbeat`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${paired.token}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      node: {
        id: 'home-mac',
        status: 'online'
      },
      relayNode: {
        status: 'degraded'
      },
      transports: [
        { kind: 'relay', health: 'degraded', lastError: 'rtt_high' }
      ]
    })
  });
  assert.equal(heartbeatResponse.status, 200);
  const heartbeat = await heartbeatResponse.json();
  assert.equal(heartbeat.ok, true);
  assert.equal(heartbeat.rpc, 'fabric.registry.node.heartbeat');
  assert.equal(heartbeat.result.registry.counts.projects, 1);
  assert.equal(heartbeat.result.registry.counts.runtimes, 1);
  assert.equal(heartbeat.result.relayNode.status, 'degraded');
  assert.equal(heartbeat.result.transports[0].health, 'degraded');

  const registryResponse = await fetch(`${controlEndpoint}/v0/fabric/registry`, {
    headers: { authorization: `Bearer ${paired.token}` }
  });
  assert.equal(registryResponse.status, 200);
  const registry = await registryResponse.json();
  assert.equal(registry.ok, true);
  assert.equal(registry.rpc, 'fabric.registry.read');
  assert.equal(registry.result.nodes[0].id, 'home-mac');
  assert.equal(registry.result.relayNodes[0].capacityClass, 'tiny');
  assert.equal(registry.result.relayNodes[0].status, 'degraded');
  assert.equal(registry.result.projects[0].name, 'ai_home');
  assert.equal(registry.result.runtimes[0].provider, 'codex');

  const nodeRpcResponse = await fetch(`${controlEndpoint}/v0/node-rpc/device-nodes`, {
    headers: { authorization: `Bearer ${paired.token}` }
  });
  assert.equal(nodeRpcResponse.status, 200);
  const nodeRpc = await nodeRpcResponse.json();
  assert.equal(nodeRpc.ok, true);
  assert.equal(nodeRpc.result.nodes.length, 1);
  assert.equal(nodeRpc.result.nodes[0].id, 'home-mac');
  assert.equal(nodeRpc.result.nodes[0].transports[0].kind, 'relay');
  assert.equal(nodeRpc.result.nodes[0].transports[0].endpoint, undefined);
});

test('server fabric transport readiness route reports relay fallback and promotion blockers', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-fabric-readiness-'));
  const port = await getFreePort();
  const controlEndpoint = `http://127.0.0.1:${port}`;
  const processObj = createProcessCapture();
  const relaySessionRegistry = { closeAll() {} };
  const invite = createControlPlaneDeviceInvite({
    name: 'Home Mac',
    controlEndpoint,
    scopes: ['nodes:read', 'nodes:write']
  }, { fs, aiHomeDir });
  const paired = consumeControlPlaneDeviceInvite({
    code: invite.code,
    device: {
      id: 'device-home-mac',
      name: 'Home Mac',
      platform: 'darwin'
    }
  }, { fs, aiHomeDir });

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

  const registerResponse = await fetch(`${controlEndpoint}/v0/fabric/registry/nodes`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${paired.token}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      node: {
        id: 'home-mac',
        name: 'Home Mac',
        roles: ['node', 'relay-node'],
        status: 'online'
      },
      relayNode: {
        status: 'online'
      },
      transports: [
        {
          id: 'home-mac-relay',
          kind: 'relay',
          health: 'online',
          measurement: {
            status: 'ws_echo_pass',
            sampleCount: 20,
            successes: 20,
            failures: 0,
            successRate: 1,
            rttMs: { p50: 3, p95: 5, p99: 6 }
          }
        },
        {
          id: 'home-mac-webrtc',
          kind: 'webrtc',
          endpoint: 'signaling://home-mac',
          health: 'online'
        }
      ]
    })
  });
  assert.equal(registerResponse.status, 200);

  const unauthenticated = await fetch(`${controlEndpoint}/v0/fabric/transport/readiness`);
  assert.equal(unauthenticated.status, 401);

  const readinessResponse = await fetch(`${controlEndpoint}/v0/fabric/transport/readiness?nodeId=home-mac&purpose=runtime`, {
    headers: { authorization: `Bearer ${paired.token}` }
  });
  assert.equal(readinessResponse.status, 200);
  const readiness = await readinessResponse.json();
  assert.equal(readiness.ok, true);
  assert.equal(readiness.rpc, 'fabric.transport.readiness');
  assert.equal(readiness.result.summary.nodes, 1);
  assert.equal(readiness.result.summary.defaultTransport, 'relay');
  assert.equal(readiness.result.summary.fallbackReady, true);
  assert.equal(readiness.result.summary.promotionReady, false);
  assert.equal(readiness.result.summary.blockers.includes('webrtc:webrtc_not_promoted'), true);

  const node = readiness.result.nodes[0];
  assert.equal(node.node.id, 'home-mac');
  assert.equal(node.relayFallback.measurementPass, true);
  assert.equal(node.relayFallback.measurement.rttMs.p95, 5);
  assert.equal(node.decision.rejected.some((item) => item.reason === 'webrtc_not_promoted'), true);
  assert.equal(node.advanced.find((gate) => gate.kind === 'webrtc').blockers.includes('turn_relay_gate_not_ready'), true);
});

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

test('server node-rpc starts native session through injectable runtime service', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-server-node-rpc-session-start-'));
  const port = await getFreePort();
  const controlEndpoint = `http://127.0.0.1:${port}`;
  const processObj = createProcessCapture();
  const relaySessionRegistry = { closeAll() {} };
  const observed = {};

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
    managementKey: 'node-secret',
    modelUsageScan: false,
    logRequests: false
  }, createServerDeps(aiHomeDir, processObj, relaySessionRegistry, {
    loadServerRuntimeAccounts: () => ({
      claude: [{
        id: '3',
        accessToken: 'token-3',
        schedulableStatus: 'schedulable',
        remainingPct: 100
      }]
    }),
    startNativeDeviceSession(payload, runtimeDeps = {}) {
      const accountId = payload.accountId || runtimeDeps.resolveSessionAccountId(payload);
      observed.start = { ...payload, accountId };
      return {
        accepted: true,
        mode: 'native-session',
        provider: payload.provider,
        accountId,
        runId: 'run-test-1',
        sessionId: 'session-test-1'
      };
    },
    readNativeSessionRunEvents(query) {
      observed.events = query;
      return {
        runId: query.runId,
        cursor: 2,
        events: [{ cursor: 2, type: 'ready' }]
      };
    },
    writeNativeSessionRunInput(payload) {
      observed.input = payload;
      return {
        accepted: true,
        runId: payload.runId,
        appendNewline: payload.appendNewline !== false
      };
    },
    abortNativeSessionRun(payload) {
      observed.abort = payload;
      return {
        accepted: true,
        runId: payload.runId
      };
    }
  }));

  const startResponse = await fetch(`${controlEndpoint}/v0/node-rpc/session-start`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer node-secret',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      provider: 'claude',
      prompt: 'hello from rpc',
      projectPath: '/tmp/project'
    })
  });
  assert.equal(startResponse.status, 200);
  const started = await startResponse.json();
  assert.equal(started.ok, true);
  assert.equal(started.rpc, 'node.session_start');
  assert.equal(started.result.runId, 'run-test-1');
  assert.deepEqual(observed.start, {
    provider: 'claude',
    accountId: '3',
    prompt: 'hello from rpc',
    projectPath: '/tmp/project'
  });

  const eventsResponse = await fetch(`${controlEndpoint}/v0/node-rpc/session-run-events?runId=run-test-1&cursor=1`, {
    headers: { authorization: 'Bearer node-secret' }
  });
  assert.equal(eventsResponse.status, 200);
  const events = await eventsResponse.json();
  assert.equal(events.rpc, 'node.session_run_events');
  assert.equal(events.result.events[0].type, 'ready');
  assert.equal(observed.events.runId, 'run-test-1');
  assert.equal(observed.events.cursor, '1');

  const inputResponse = await fetch(`${controlEndpoint}/v0/node-rpc/session-run-input`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer node-secret',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      runId: 'run-test-1',
      input: '/status',
      appendNewline: true
    })
  });
  assert.equal(inputResponse.status, 200);
  const input = await inputResponse.json();
  assert.equal(input.rpc, 'node.session_run_input');
  assert.equal(input.result.accepted, true);
  assert.equal(observed.input.input, '/status');

  const commandResponse = await fetch(`${controlEndpoint}/v0/node-rpc/session-command`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer node-secret',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      type: 'slash',
      sessionId: 'run-test-1',
      command: '/status',
      idempotencyKey: 'idem-http-command'
    })
  });
  assert.equal(commandResponse.status, 200);
  const command = await commandResponse.json();
  assert.equal(command.rpc, 'node.session_command');
  assert.equal(command.result.accepted, true);
  assert.equal(command.result.type, 'slash');
  assert.equal(command.result.idempotencyKey, 'idem-http-command');
  assert.equal(observed.input.input, '/status');

  const abortResponse = await fetch(`${controlEndpoint}/v0/node-rpc/session-run-abort`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer node-secret',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      runId: 'run-test-1'
    })
  });
  assert.equal(abortResponse.status, 200);
  const aborted = await abortResponse.json();
  assert.equal(aborted.rpc, 'node.session_run_abort');
  assert.equal(aborted.result.accepted, true);
  assert.equal(observed.abort.runId, 'run-test-1');
});

test('server node-rpc device node session start and run controls forward through relay management', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-server-node-rpc-remote-session-start-'));
  const port = await getFreePort();
  const controlEndpoint = `http://127.0.0.1:${port}`;
  const paired = seedPairedDeviceNode(aiHomeDir, controlEndpoint, ['nodes:read', 'sessions:read', 'sessions:write']);
  const processObj = createProcessCapture();
  const relaySessionRegistry = { closeAll() {} };
  const forwarded = [];
  const transportEvidence = {
    transport: { id: 'home-win-relay', kind: 'relay', endpoint: 'relay://home-win' },
    transportDecision: {
      transportPurpose: 'stream',
      selectedTransportId: 'home-win-relay',
      selectedTransportKind: 'relay',
      fallbackUsed: false,
      fallbackFrom: [],
      rejectedTransports: []
    }
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
  }, createServerDeps(aiHomeDir, processObj, relaySessionRegistry, {
    requestRemoteManagement: async (input) => {
      forwarded.push(input);
      if (input.pathname === '/v0/node-rpc/session-start') {
        return {
          ...transportEvidence,
          ok: true,
          status: 200,
          payload: {
            ok: true,
            rpc: 'node.session_start',
            result: { accepted: true, runId: 'run-remote-1', provider: 'codex' }
          }
        };
      }
      if (String(input.pathname).startsWith('/v0/node-rpc/session-run-events')) {
        return {
          ...transportEvidence,
          ok: true,
          status: 200,
          payload: {
            ok: true,
            rpc: 'node.session_run_events',
            result: { runId: 'run-remote-1', cursor: 1, events: [{ cursor: 1, type: 'ready' }] }
          }
        };
      }
      if (input.pathname === '/v0/node-rpc/session-run-input') {
        return {
          ...transportEvidence,
          ok: true,
          status: 200,
          payload: {
            ok: true,
            rpc: 'node.session_run_input',
            result: { accepted: true, runId: 'run-remote-1' }
          }
        };
      }
      if (input.pathname === '/v0/node-rpc/session-command') {
        return {
          ...transportEvidence,
          ok: true,
          status: 200,
          payload: {
            ok: true,
            rpc: 'node.session_command',
            result: {
              accepted: true,
              commandId: 'idem-remote-command',
              idempotencyKey: 'idem-remote-command',
              type: 'message',
              sessionId: 'run-remote-1',
              runId: 'run-remote-1'
            }
          }
        };
      }
      if (input.pathname === '/v0/node-rpc/session-run-abort') {
        return {
          ...transportEvidence,
          ok: true,
          status: 200,
          payload: {
            ok: true,
            rpc: 'node.session_run_abort',
            result: { accepted: true, runId: 'run-remote-1' }
          }
        };
      }
      return {
        ok: false,
        status: 404,
        payload: { ok: false, error: 'unexpected_path' }
      };
    }
  }));

  const startResponse = await fetch(`${controlEndpoint}/v0/node-rpc/device-node-session-start`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${paired.token}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      nodeId: 'home-win',
      provider: 'codex',
      accountId: '3',
      prompt: 'remote start'
    })
  });
  assert.equal(startResponse.status, 200);
  const started = await startResponse.json();
  assert.equal(started.rpc, 'control_plane.device.node_session_start');
  assert.equal(started.nodeId, 'home-win');
  assert.deepEqual(started.transport, { id: 'home-win-relay', kind: 'relay' });
  assert.equal(started.transportDecision.selectedTransportKind, 'relay');
  assert.equal(started.result.runId, 'run-remote-1');

  const eventsResponse = await fetch(`${controlEndpoint}/v0/node-rpc/device-node-session-run-events?nodeId=home-win&runId=run-remote-1&cursor=0`, {
    headers: { authorization: `Bearer ${paired.token}` }
  });
  assert.equal(eventsResponse.status, 200);
  const events = await eventsResponse.json();
  assert.equal(events.rpc, 'control_plane.device.node_session_run_events');
  assert.equal(events.transport.kind, 'relay');
  assert.equal(events.transportDecision.selectedTransportKind, 'relay');
  assert.equal(events.result.events[0].type, 'ready');

  const inputResponse = await fetch(`${controlEndpoint}/v0/node-rpc/device-node-session-run-input`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${paired.token}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      nodeId: 'home-win',
      runId: 'run-remote-1',
      input: '/status'
    })
  });
  assert.equal(inputResponse.status, 200);
  const input = await inputResponse.json();
  assert.equal(input.rpc, 'control_plane.device.node_session_run_input');
  assert.equal(input.result.accepted, true);

  const commandResponse = await fetch(`${controlEndpoint}/v0/node-rpc/device-node-session-command`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${paired.token}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      nodeId: 'home-win',
      type: 'message',
      sessionId: 'run-remote-1',
      text: 'remote command',
      idempotencyKey: 'idem-remote-command'
    })
  });
  assert.equal(commandResponse.status, 200);
  const command = await commandResponse.json();
  assert.equal(command.rpc, 'control_plane.device.node_session_command');
  assert.equal(command.result.accepted, true);
  assert.equal(command.result.type, 'message');

  const abortResponse = await fetch(`${controlEndpoint}/v0/node-rpc/device-node-session-run-abort`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${paired.token}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      nodeId: 'home-win',
      runId: 'run-remote-1'
    })
  });
  assert.equal(abortResponse.status, 200);
  const aborted = await abortResponse.json();
  assert.equal(aborted.rpc, 'control_plane.device.node_session_run_abort');
  assert.equal(aborted.result.accepted, true);

  assert.deepEqual(forwarded.map((item) => item.pathname), [
    '/v0/node-rpc/session-start',
    '/v0/node-rpc/session-run-events?runId=run-remote-1&cursor=0',
    '/v0/node-rpc/session-run-input',
    '/v0/node-rpc/session-command',
    '/v0/node-rpc/session-run-abort'
  ]);
  assert.equal(JSON.parse(forwarded[0].body).prompt, 'remote start');
  assert.equal(JSON.parse(forwarded[2].body).input, '/status');
  assert.equal(JSON.parse(forwarded[3].body).text, 'remote command');
  assert.equal(JSON.parse(forwarded[3].body).idempotencyKey, 'idem-remote-command');
  assert.equal(JSON.parse(forwarded[4].body).runId, 'run-remote-1');
});

test('server node-rpc device node session start forwards remote failure reason', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-server-node-rpc-session-start-error-'));
  const port = await getFreePort();
  const controlEndpoint = `http://127.0.0.1:${port}`;
  const paired = seedPairedDeviceNode(aiHomeDir, controlEndpoint, ['nodes:read', 'sessions:write']);
  const processObj = createProcessCapture();
  const relaySessionRegistry = { closeAll() {} };

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
  }, createServerDeps(aiHomeDir, processObj, relaySessionRegistry, {
    requestRemoteManagement: async () => ({
      ok: false,
      status: 400,
      payload: {
        ok: false,
        error: 'cli_not_found',
        message: '未找到 claude CLI'
      }
    })
  }));

  const response = await fetch(`${controlEndpoint}/v0/node-rpc/device-node-session-start`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${paired.token}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      nodeId: 'home-win',
      provider: 'claude',
      prompt: 'remote start'
    })
  });

  assert.equal(response.status, 400);
  const payload = await response.json();
  assert.equal(payload.ok, false);
  assert.equal(payload.error, 'cli_not_found');
  assert.equal(payload.message, '未找到 claude CLI');
  assert.equal(payload.remoteStatus, 400);
});

test('server node-rpc device sessions uses injected project snapshot loader', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-server-node-rpc-snapshot-'));
  const port = await getFreePort();
  const controlEndpoint = `http://127.0.0.1:${port}`;
  const paired = seedPairedDeviceNode(aiHomeDir, controlEndpoint, ['sessions:read']);
  const processObj = createProcessCapture();
  const relaySessionRegistry = { closeAll() {} };
  let snapshotCalls = 0;
  const getProjectsSnapshot = async () => {
    snapshotCalls += 1;
    return {
      projects: [{
        id: 'project-smoke',
        name: 'Injected Project',
        path: '/work/injected',
        sessions: [{
          id: 'session-smoke',
          provider: 'codex',
          title: 'Injected Session',
          updatedAt: 1234
        }]
      }]
    };
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
  }, createServerDeps(aiHomeDir, processObj, relaySessionRegistry, { getProjectsSnapshot }));

  const response = await fetch(`${controlEndpoint}/v0/node-rpc/device-sessions`, {
    headers: {
      authorization: `Bearer ${paired.token}`
    }
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.ok, true);
  assert.equal(snapshotCalls, 1);
  assert.equal(payload.result.summary.total, 1);
  assert.equal(payload.result.sessions[0].title, 'Injected Session');
});
