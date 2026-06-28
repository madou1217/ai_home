const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('fs-extra');

const {
  getFabricRegistryPath,
  heartbeatFabricNode,
  listFabricRegistry,
  registerFabricNode
} = require('../lib/server/fabric-role-registry');
const { getRemoteNode } = require('../lib/server/remote/node-registry');
const { listNodeTransports } = require('../lib/server/remote/transport-registry');
const { selectTransport } = require('../lib/server/remote/transport-selector');

test('fabric role registry stores node roles projects runtimes relay metadata and mirrors legacy relay transport', (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-fabric-role-registry-'));
  let now = 1000;
  const deps = { fs, aiHomeDir, now: () => now };
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  const result = registerFabricNode({
    node: {
      id: 'home-mac',
      name: 'Home Mac',
      roles: ['node', 'relay-node'],
      platform: 'darwin',
      arch: 'arm64',
      machineFingerprint: 'raw-machine-id',
      capabilities: ['projects', 'sessions', 'runtime:codex']
    },
    relayNode: {
      capacityClass: 'tiny',
      bandwidthLimitKbps: 3072,
      allowedScopes: ['family']
    },
    transports: [
      { id: 'home-mac-wss', kind: 'wss', endpoint: 'wss://home.example.com/fabric', priority: 10, health: 'up' },
      { id: 'home-mac-relay', kind: 'relay', health: 'up', priority: 20 }
    ],
    projects: [
      { path: '/Users/model/projects/feature/ai_home', name: 'ai_home', vcs: 'git', permissions: ['read', 'write'] }
    ],
    runtimes: [
      { provider: 'codex', mode: 'tui', version: '0.142.0', capabilities: ['slash', 'approval'] },
      { provider: 'claude', mode: 'tui', version: '1.0.0' }
    ]
  }, deps);

  assert.equal(result.node.id, 'home-mac');
  assert.deepEqual(result.node.roles, ['node', 'relay-node']);
  assert.match(result.node.machineFingerprintHash, /^sha256:/);
  assert.doesNotMatch(JSON.stringify(result.registry), /raw-machine-id/);
  assert.equal(result.relayNode.nodeId, 'home-mac');
  assert.equal(result.projects.length, 1);
  assert.equal(result.projects[0].name, 'ai_home');
  assert.match(result.projects[0].pathHash, /^sha256:/);
  assert.equal(result.runtimes.length, 2);
  assert.deepEqual(result.runtimes.map((runtime) => runtime.provider), ['codex', 'claude']);
  assert.equal(result.transports.length, 2);
  assert.equal(fs.existsSync(getFabricRegistryPath(aiHomeDir)), true);

  const registry = listFabricRegistry(deps);
  assert.deepEqual(registry.counts, {
    nodes: 1,
    relayNodes: 1,
    transports: 2,
    projects: 1,
    runtimes: 2
  });
  assert.equal(registry.nodeInventory.length, 1);
  assert.equal(registry.nodeInventory[0].capabilities.runtimeHost, true);
  assert.deepEqual(registry.nodeInventory[0].capabilities.runtimeProviders, ['claude', 'codex']);
  assert.equal(registry.nodeInventory[0].actions.find((action) => action.id === 'start-session:codex').eligible, true);
  assert.deepEqual(
    registry.nodeInventory[0].actions.find((action) => action.id === 'start-session:codex').blockers,
    ['m4_remote_session_action_pending']
  );

  const legacyNode = getRemoteNode('home-mac', deps);
  assert.equal(legacyNode.role, 'relay-node');
  assert.equal(legacyNode.tags.includes('role:relay-node'), true);
  const legacyTransports = listNodeTransports('home-mac', deps);
  assert.deepEqual(legacyTransports.map((transport) => transport.kind), ['relay']);
  assert.equal(legacyTransports[0].endpoint, 'relay://home-mac');

  now = 2000;
  const updated = registerFabricNode({
    node: {
      id: 'home-mac',
      name: 'Home Mac',
      roles: ['node'],
      status: 'online'
    },
    projects: [],
    runtimes: [
      { provider: 'opencode', mode: 'tui', version: '0.8.0' }
    ],
    transports: [
      { id: 'home-mac-relay', kind: 'relay', health: 'up' }
    ]
  }, deps);

  assert.equal(updated.registry.counts.nodes, 1);
  assert.equal(updated.registry.counts.projects, 0);
  assert.equal(updated.registry.counts.runtimes, 1);
  assert.equal(updated.registry.runtimes[0].provider, 'opencode');
});

test('fabric role registry heartbeat preserves projects and runtimes while updating liveness', (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-fabric-role-heartbeat-'));
  let now = 1000;
  const deps = { fs, aiHomeDir, now: () => now };
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  registerFabricNode({
    node: {
      id: 'office-pc',
      name: 'Office PC',
      roles: ['node', 'relay-node'],
      ownerDeviceId: 'device-office'
    },
    relayNode: {
      capacityClass: 'tiny',
      bandwidthLimitKbps: 2048,
      status: 'online'
    },
    transports: [
      { id: 'office-pc-relay', kind: 'relay', health: 'unknown', priority: 20 }
    ],
    projects: [
      { path: '/srv/project', name: 'project', permissions: ['read', 'write'] }
    ],
    runtimes: [
      { provider: 'codex', mode: 'api', status: 'available' },
      { provider: 'gemini', mode: 'api', status: 'available' }
    ]
  }, deps);

  now = 5000;
  const touched = heartbeatFabricNode({
    node: {
      id: 'office-pc',
      status: 'online'
    },
    relayNode: {
      status: 'degraded'
    },
    transports: [
      {
        kind: 'relay',
        health: 'degraded',
        lastError: 'rtt_high',
        measurement: {
          status: 'tcp_echo_fail',
          durationMs: 42,
          successes: 1,
          failures: 1,
          sampleCount: 2,
          successRate: 0.5,
          failureReason: 'echo_response_timeout',
          rttMs: { min: 20, p50: 20, p95: 42, max: 42, avg: 31, count: 2 }
        }
      }
    ]
  }, {
    ...deps,
    ownerDeviceId: 'device-office'
  });

  assert.equal(touched.node.lastSeenAt, 5000);
  assert.equal(touched.relayNode.status, 'degraded');
  assert.equal(touched.relayNode.bandwidthLimitKbps, 2048);
  assert.equal(touched.transports.length, 1);
  assert.equal(touched.transports[0].health, 'degraded');
  assert.equal(touched.transports[0].lastError, 'rtt_high');
  assert.deepEqual(touched.transports[0].measurement, {
    status: 'tcp_echo_fail',
    durationMs: 42,
    successes: 1,
    failures: 1,
    measuredAt: 5000,
    sampleCount: 2,
    successRate: 0.5,
    failureReason: 'echo_response_timeout',
    rttMs: { min: 20, p50: 20, p95: 42, max: 42, avg: 31, count: 2 }
  });
  assert.equal(touched.registry.counts.projects, 1);
  assert.equal(touched.registry.counts.runtimes, 2);
  assert.deepEqual(touched.registry.runtimes.map((runtime) => runtime.provider), ['codex', 'gemini']);
  assert.equal(touched.registry.networkMeasurements.length, 1);
  assert.deepEqual(touched.registry.networkMeasurements[0], {
    id: touched.registry.networkMeasurements[0].id,
    nodeId: 'office-pc',
    transportId: 'office-pc-relay',
    transportKind: 'relay',
    ownerType: 'relay-node',
    ownerId: 'office-pc-relay',
    status: 'tcp_echo_fail',
    durationMs: 42,
    successes: 1,
    failures: 1,
    measuredAt: 5000,
    createdAt: 5000,
    sampleCount: 2,
    successRate: 0.5,
    failureReason: 'echo_response_timeout',
    rttMs: { min: 20, p50: 20, p95: 42, max: 42, avg: 31, count: 2 }
  });

  const registry = listFabricRegistry(deps);
  assert.deepEqual(registry.counts, {
    nodes: 1,
    relayNodes: 1,
    transports: 1,
    projects: 1,
    runtimes: 2
  });
  assert.equal(registry.projects[0].name, 'project');
  assert.equal(registry.runtimes[1].provider, 'gemini');
  assert.equal(registry.networkMeasurements[0].transportId, 'office-pc-relay');

  const legacyNode = getRemoteNode('office-pc', deps);
  assert.equal(legacyNode.lastSeenAt, 5000);
  const legacyTransports = listNodeTransports('office-pc', deps);
  assert.equal(legacyTransports[0].status, 'degraded');

  assert.throws(
    () => heartbeatFabricNode({ node: { id: 'office-pc' } }, { ...deps, ownerDeviceId: 'device-other' }),
    /forbidden_fabric_node_owner/
  );
});

test('fabric role registry mirrors online relay as selectable legacy transport', (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-fabric-role-selectable-relay-'));
  const deps = { fs, aiHomeDir, now: () => 1000 };
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  registerFabricNode({
    node: {
      id: 'relay-client',
      name: 'Relay Client',
      roles: ['node', 'relay-node'],
      capabilities: ['status']
    },
    transports: [
      { id: 'relay-client-relay', kind: 'relay', health: 'online', priority: 100 }
    ]
  }, deps);

  const legacyNode = getRemoteNode('relay-client', deps);
  const legacyTransports = listNodeTransports('relay-client', deps);
  assert.equal(legacyTransports.length, 1);
  assert.equal(legacyTransports[0].status, 'up');
  assert.equal(legacyTransports[0].score, 55);
  assert.equal(selectTransport(legacyNode, legacyTransports, { purpose: 'status' })?.id, 'relay-client-relay');
});
