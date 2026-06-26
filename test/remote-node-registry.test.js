const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('fs-extra');

const {
  getRemoteRegistryPath,
  readRemoteRegistry
} = require('../lib/server/remote/remote-registry-store');
const {
  listRemoteNodes,
  upsertRemoteNode
} = require('../lib/server/remote/node-registry');
const {
  listNodeTransports,
  transportSupportsRemoteRequest,
  upsertRemoteTransport
} = require('../lib/server/remote/transport-registry');
const {
  getRemoteSecretPath,
  readRemoteSecret,
  writeRemoteSecret
} = require('../lib/server/remote/secret-store');
const {
  selectTransport
} = require('../lib/server/remote/transport-selector');
const { buildRemoteTransportStrategies } = require('../lib/server/remote/transport-strategies');
const {
  inferTransportPurpose,
  requestRemoteManagement,
  streamRemoteManagement
} = require('../lib/server/remote/remote-gateway');
const { appendSearch } = require('../lib/server/remote/remote-management-routes');
const { listRemoteNodeViews } = require('../lib/server/remote/remote-node-view');
const { getRemoteAuditLogPath } = require('../lib/server/remote/audit-log');
const {
  buildRemoteNodeIdentity,
  normalizeCloneRepoUrl,
  resolveMachineId
} = require('../lib/server/remote/node-defaults');

test('remote node identity prefers machine id over ai home directory', () => {
  const baseDeps = {
    hostname: () => 'Office PC',
    platform: 'linux',
    arch: 'x64',
    machineId: '12345678-90ab-cdef-1234-567890abcdef'
  };

  const first = buildRemoteNodeIdentity({}, { ...baseDeps, aiHomeDir: '/tmp/aih-a' });
  const second = buildRemoteNodeIdentity({}, { ...baseDeps, aiHomeDir: '/tmp/aih-b' });

  assert.equal(first.name, 'Office PC');
  assert.equal(first.nodeId, second.nodeId);
  assert.match(first.nodeId, /^office-pc-[a-f0-9]{8}$/);
  assert.doesNotMatch(first.nodeId, /12345678|90ab|cdef/);
});

test('remote node identity falls back to install scoped seed without machine id', () => {
  const baseDeps = {
    hostname: () => 'Office PC',
    platform: 'linux',
    arch: 'x64',
    machineId: ''
  };

  const first = buildRemoteNodeIdentity({}, { ...baseDeps, aiHomeDir: '/tmp/aih-a' });
  const second = buildRemoteNodeIdentity({}, { ...baseDeps, aiHomeDir: '/tmp/aih-b' });

  assert.notEqual(first.nodeId, second.nodeId);
  assert.match(first.nodeId, /^office-pc-[a-f0-9]{8}$/);
  assert.match(second.nodeId, /^office-pc-[a-f0-9]{8}$/);
});

test('remote node identity reads platform machine identifiers', () => {
  assert.equal(resolveMachineId({
    platform: 'linux',
    fs: {
      readFileSync(filePath) {
        if (filePath === '/etc/machine-id') return 'abcdef1234567890abcdef1234567890\n';
        throw new Error('not found');
      }
    }
  }), 'abcdef1234567890abcdef1234567890');

  assert.equal(resolveMachineId({
    platform: 'darwin',
    spawnSync: () => ({
      status: 0,
      stdout: '    "IOPlatformUUID" = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE"\n'
    })
  }), 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE');

  assert.equal(resolveMachineId({
    platform: 'win32',
    spawnSync: () => ({
      status: 0,
      stdout: '    MachineGuid    REG_SZ    11111111-2222-3333-4444-555555555555\r\n'
    })
  }), '11111111-2222-3333-4444-555555555555');
});

test('remote node defaults normalize git ssh origins to clone-friendly https urls', () => {
  assert.equal(
    normalizeCloneRepoUrl('git@github.com:madou1217/ai_home.git'),
    'https://github.com/madou1217/ai_home.git'
  );
  assert.equal(
    normalizeCloneRepoUrl('ssh://git@gitlab.com/group/ai_home.git'),
    'https://gitlab.com/group/ai_home.git'
  );
  assert.equal(
    normalizeCloneRepoUrl('https://github.com/madou1217/ai_home.git'),
    'https://github.com/madou1217/ai_home.git'
  );
  assert.equal(
    normalizeCloneRepoUrl('ssh://deploy@example.com/ai_home.git'),
    'ssh://deploy@example.com/ai_home.git'
  );
  assert.equal(
    normalizeCloneRepoUrl('ssh://git@example.com:2222/ai_home.git'),
    'ssh://git@example.com:2222/ai_home.git'
  );
});

test('remote node registry stores nodes and transports without credential payloads', (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-remote-registry-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const deps = { fs, aiHomeDir };

  const node = upsertRemoteNode({
    id: 'home-mac',
    name: 'Home Mac',
    preferredTransports: ['tailscale', 'frp', 'direct'],
    capabilities: ['status', 'accounts']
  }, deps);
  const transport = upsertRemoteTransport({
    id: 'home-mac-tailscale',
    nodeId: node.id,
    kind: 'tailscale',
    endpoint: 'http://100.64.0.10:9527/',
    score: 70,
    status: 'up',
    provider: 'tailscale',
    routeRole: 'data-plane',
    trustLevel: 'verified'
  }, deps);
  writeRemoteSecret(node.authRef, { managementKey: 'mgmt-secret' }, deps);

  assert.equal(node.id, 'home-mac');
  assert.equal(transport.endpoint, 'http://100.64.0.10:9527');
  assert.equal(transport.provider, 'tailscale');
  assert.equal(transport.routeRole, 'data-plane');
  assert.equal(transport.trustLevel, 'verified');
  assert.equal(listRemoteNodes(deps).length, 1);
  assert.equal(listNodeTransports('home-mac', deps).length, 1);
  assert.equal(readRemoteSecret(node.authRef, deps).managementKey, 'mgmt-secret');

  const registryText = fs.readFileSync(getRemoteRegistryPath(aiHomeDir), 'utf8');
  assert.doesNotMatch(registryText, /mgmt-secret/);
  assert.match(fs.readFileSync(getRemoteSecretPath(aiHomeDir), 'utf8'), /mgmt-secret/);
  assert.equal(readRemoteRegistry(deps).version, 1);
});

test('remote transport selector prefers healthy preferred HTTP transports', () => {
  const node = {
    preferredTransports: ['frp', 'direct']
  };
  const selected = selectTransport(node, [
    { id: 'relay', kind: 'relay', endpoint: 'relay://home-mac', score: 100, status: 'up' },
    { id: 'direct', kind: 'direct', endpoint: 'http://direct.example.com', score: 50, status: 'up', latencyMs: 20 },
    { id: 'frp', kind: 'frp', endpoint: 'https://frp.example.com', score: 50, status: 'up', latencyMs: 20 }
  ]);

  assert.equal(selected.id, 'frp');
});

test('remote relay transport is a normalized fallback for remote requests', (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-remote-relay-transport-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const deps = { fs, aiHomeDir };

  upsertRemoteNode({ id: 'home-mac', name: 'Home Mac' }, deps);
  const relay = upsertRemoteTransport({
    id: 'home-mac-relay',
    nodeId: 'home-mac',
    kind: 'relay',
    status: 'up',
    score: 55
  }, deps);
  assert.equal(relay.endpoint, 'relay://home-mac');
  assert.equal(transportSupportsRemoteRequest(relay), true);

  const selected = selectTransport({ preferredTransports: ['relay'] }, [
    relay
  ], { purpose: 'read' });
  assert.equal(selected.id, 'home-mac-relay');
});

test('remote node view derives relay connection state from active sessions', (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-remote-node-view-relay-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const deps = { fs, aiHomeDir };

  upsertRemoteNode({ id: 'nat-node', name: 'NAT Node' }, deps);
  upsertRemoteTransport({
    id: 'nat-node-relay',
    nodeId: 'nat-node',
    kind: 'relay',
    status: 'degraded',
    score: 0
  }, deps);

  const offline = listRemoteNodeViews(deps)[0];
  assert.equal(offline.connection.status, 'offline');
  assert.equal(offline.connection.transportKind, 'relay');
  assert.equal(offline.connection.transportId, 'nat-node-relay');
  assert.equal(offline.connection.sessionId, '');

  const online = listRemoteNodeViews({
    ...deps,
    relaySessionRegistry: {
      getRelaySession: () => ({
        sessionId: 'session-1',
        nodeId: 'nat-node',
        transportId: 'nat-node-relay',
        remoteAddress: '192.0.2.10',
        connectedAt: 1000,
        lastSeenAt: 1500
      })
    }
  })[0];
  assert.equal(online.connection.status, 'online');
  assert.equal(online.connection.sessionId, 'session-1');
  assert.equal(online.connection.remoteAddress, '192.0.2.10');
  assert.equal(online.connection.connectedAt, 1000);
  assert.equal(online.connection.lastSeenAt, 1500);
});

test('remote transport selector applies purpose-specific transport roles', () => {
  const streamSelected = selectTransport({}, [
    { id: 'frp', kind: 'frp', endpoint: 'https://frp.example.com', score: 62, status: 'up', latencyMs: 20 },
    { id: 'mptcp', kind: 'mptcp', endpoint: 'https://mptcp.example.com', score: 56, status: 'up', latencyMs: 20 }
  ], { purpose: 'stream' });
  assert.equal(streamSelected.id, 'mptcp');

  const bootstrapSelected = selectTransport({}, [
    { id: 'frp', kind: 'frp', endpoint: 'https://frp.example.com', score: 64, status: 'up', latencyMs: 20 },
    { id: 'ssh', kind: 'ssh', endpoint: 'http://127.0.0.1:19527', score: 58, status: 'up', latencyMs: 20 }
  ], { purpose: 'bootstrap' });
  assert.equal(bootstrapSelected.id, 'ssh');
});

test('remote transport strategies classify data-plane, bootstrap, and underlay lanes', () => {
  const strategies = buildRemoteTransportStrategies();
  const byId = new Map(strategies.map((strategy) => [strategy.id, strategy]));

  assert.deepEqual(byId.get('no-public-ip-default').dataPlaneTransports, ['relay']);
  assert.deepEqual(byId.get('no-public-ip-default').bootstrapTransports, ['ssh']);
  assert.deepEqual(byId.get('underlay-optimization').underlayTransports, ['omr', 'mptcp']);
  assert.equal(byId.get('underlay-optimization').dataPlaneTransports.length, 0);
});

test('remote transport selector keeps non-data-plane routes out of normal rpc selection', () => {
  const readSelected = selectTransport({}, [
    {
      id: 'ssh-bootstrap',
      kind: 'ssh',
      endpoint: 'http://127.0.0.1:19527',
      status: 'up',
      score: 100,
      routeRole: 'bootstrap'
    },
    {
      id: 'frp',
      kind: 'frp',
      endpoint: 'https://frp.example.com',
      status: 'up',
      score: 40
    }
  ], { purpose: 'read' });
  assert.equal(readSelected.id, 'frp');

  const bootstrapSelected = selectTransport({}, [
    {
      id: 'ssh-bootstrap',
      kind: 'ssh',
      endpoint: 'http://127.0.0.1:19528',
      status: 'up',
      score: 40,
      routeRole: 'bootstrap'
    },
    {
      id: 'underlay',
      kind: 'omr',
      endpoint: 'http://10.0.0.2:9527',
      status: 'up',
      score: 100,
      routeRole: 'underlay'
    }
  ], { purpose: 'bootstrap' });
  assert.equal(bootstrapSelected.id, 'ssh-bootstrap');

  const statusSelected = selectTransport({}, [
    {
      id: 'ssh-bootstrap',
      kind: 'ssh',
      endpoint: 'http://127.0.0.1:19528',
      status: 'up',
      score: 100,
      routeRole: 'bootstrap'
    }
  ], { purpose: 'status' });
  assert.equal(statusSelected, null);
});

test('remote gateway infers transport purpose from rpc and path', () => {
  assert.equal(inferTransportPurpose({ rpc: 'node.status.read' }), 'status');
  assert.equal(inferTransportPurpose({ rpc: 'node.chat.start', streamKind: 'sse' }), 'stream');
  assert.equal(inferTransportPurpose({ pathname: '/v0/management/files/read' }), 'file');
  assert.equal(inferTransportPurpose({ scope: 'runtime:restart' }), 'runtime');
  assert.equal(inferTransportPurpose({ pathname: '/v0/node-rpc/join' }), 'bootstrap');
});

test('remote management appendSearch preserves existing diagnostic query params', () => {
  assert.equal(
    appendSearch('/v0/node-rpc/status?diagnostics=1', new URL('https://control.example.com/test?summary=1')),
    '/v0/node-rpc/status?diagnostics=1&summary=1'
  );
  assert.equal(
    appendSearch('/v0/node-rpc/status', new URL('https://control.example.com/test?summary=1')),
    '/v0/node-rpc/status?summary=1'
  );
});

test('remote gateway requires relay rpc handler before using relay transport', async () => {
  await assert.rejects(
    requestRemoteManagement({
      node: {
        id: 'nat-node',
        preferredTransports: ['relay']
      },
      transports: [
        {
          id: 'nat-node-relay',
          nodeId: 'nat-node',
          kind: 'relay',
          endpoint: 'relay://nat-node',
          status: 'up',
          score: 55
        }
      ],
      pathname: '/v0/management/status',
      audit: false
    }),
    { code: 'remote_relay_rpc_not_implemented', status: 501 }
  );
});

test('remote gateway posts direct session input with management bearer and audit', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-remote-input-direct-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const deps = { fs, aiHomeDir };
  const node = upsertRemoteNode({
    id: 'direct-input-node',
    name: 'Direct Input Node',
    preferredTransports: ['direct'],
    capabilities: ['sessions']
  }, deps);
  upsertRemoteTransport({
    id: 'direct-input-node-http',
    nodeId: node.id,
    kind: 'direct',
    endpoint: 'http://127.0.0.1:9527',
    status: 'up',
    score: 80
  }, deps);
  writeRemoteSecret(node.authRef, { managementKey: 'direct-secret' }, deps);

  const body = JSON.stringify({
    sessionRef: 'sess_0123456789abcdefabcd',
    input: 'remote yes',
    appendNewline: true
  });
  const calls = [];
  const result = await requestRemoteManagement({
    node,
    transports: listNodeTransports(node.id, deps),
    pathname: '/v0/node-rpc/session-input',
    method: 'POST',
    body,
    rpc: 'control_plane.device.node_session_input',
    scope: 'sessions:write'
  }, {
    ...deps,
    fetchImpl: async (url, init) => {
      calls.push({
        url: String(url),
        method: init && init.method,
        authorization: init && init.headers && init.headers.authorization,
        contentType: init && init.headers && init.headers['content-type'],
        body: init && init.body
      });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true, rpc: 'node.session_input', result: { accepted: true } })
      };
    }
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    {
      url: 'http://127.0.0.1:9527/v0/node-rpc/session-input',
      method: 'POST',
      authorization: 'Bearer direct-secret',
      contentType: 'application/json',
      body
    }
  ]);
  const auditText = fs.readFileSync(getRemoteAuditLogPath(aiHomeDir), 'utf8');
  assert.match(auditText, /control_plane\.device\.node_session_input/);
  assert.match(auditText, /sessions:write/);
  assert.doesNotMatch(auditText, /remote yes/);
  assert.doesNotMatch(auditText, /direct-secret/);
});

test('remote gateway streams direct session events with management bearer and audit', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-remote-stream-direct-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const deps = { fs, aiHomeDir };
  const node = upsertRemoteNode({
    id: 'direct-node',
    name: 'Direct Node',
    preferredTransports: ['direct'],
    capabilities: ['sessions']
  }, deps);
  upsertRemoteTransport({
    id: 'direct-node-http',
    nodeId: node.id,
    kind: 'direct',
    endpoint: 'http://127.0.0.1:9527',
    status: 'up',
    score: 60
  }, deps);
  writeRemoteSecret(node.authRef, { managementKey: 'direct-secret' }, deps);
  const encoder = new TextEncoder();
  const chunks = [];
  const opened = [];
  const result = await streamRemoteManagement({
    node,
    transports: listNodeTransports(node.id, deps),
    pathname: '/v0/node-rpc/session-stream?sessionRef=sess_0123456789abcdefabcd',
    method: 'GET',
    rpc: 'control_plane.device.node_session_stream',
    scope: 'sessions:read'
  }, {
    onOpen: (message) => opened.push(message),
    onChunk: (payload) => chunks.push(payload)
  }, {
    ...deps,
    fetchImpl: async (url, init) => {
      assert.equal(url, 'http://127.0.0.1:9527/v0/node-rpc/session-stream?sessionRef=sess_0123456789abcdefabcd');
      assert.equal(init.method, 'GET');
      assert.equal(init.headers.authorization, 'Bearer direct-secret');
      return {
        ok: true,
        status: 200,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode('data: {"ok":true,"type":"events","result":{"cursor":8192}}\n\n'));
            controller.close();
          }
        })
      };
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.transport.kind, 'direct');
  assert.deepEqual(opened, [{ type: 'remote.stream.opened', status: 200, ok: true }]);
  assert.deepEqual(chunks, [
    { ok: true, type: 'events', result: { cursor: 8192 } }
  ]);
  const auditText = fs.readFileSync(getRemoteAuditLogPath(aiHomeDir), 'utf8');
  assert.match(auditText, /control_plane\.device\.node_session_stream/);
  assert.match(auditText, /sessions:read/);
  assert.doesNotMatch(auditText, /direct-secret/);
});

test('remote gateway requires relay stream handler before using relay stream transport', async () => {
  await assert.rejects(
    streamRemoteManagement({
      node: {
        id: 'nat-node',
        preferredTransports: ['relay']
      },
      transports: [
        {
          id: 'nat-node-relay',
          nodeId: 'nat-node',
          kind: 'relay',
          endpoint: 'relay://nat-node',
          status: 'up',
          score: 55
        }
      ],
      pathname: '/v0/node-rpc/session-stream?sessionRef=sess_0123456789abcdefabcd',
      audit: false
    }),
    { code: 'remote_relay_stream_not_implemented', status: 501 }
  );
});
