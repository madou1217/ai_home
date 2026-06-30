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
const {
  listNodeTransports,
  transportSupportsRemoteRequest,
  upsertRemoteTransport
} = require('../lib/server/remote/transport-registry');
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
  assert.equal(registry.nodeInventory[0].actions.find((action) => action.id === 'start-session:codex').enabled, true);
  assert.deepEqual(
    registry.nodeInventory[0].actions.find((action) => action.id === 'start-session:codex').blockers,
    []
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

test('fabric role registry persists runtime diagnostics for inventory gap blockers', (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-fabric-runtime-diagnostics-'));
  const deps = { fs, aiHomeDir, now: () => 9000 };
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  registerFabricNode({
    node: {
      id: 'aws-current-node',
      status: 'online',
      ownerDeviceId: 'device-aws-current'
    },
    projects: [
      { path: '/home/ubuntu/aih-fabric-current', name: 'aih-fabric-current' }
    ],
    transports: [
      { kind: 'relay', health: 'online' }
    ]
  }, deps);

  const touched = heartbeatFabricNode({
    node: {
      id: 'aws-current-node',
      status: 'online'
    },
    relayNode: {
      status: 'online'
    },
    transports: [
      { kind: 'relay', health: 'online' }
    ],
    runtimeDiagnostics: [
      {
        provider: 'codex',
        cli: { command: 'codex', available: false },
        accounts: { total: 0, source: 'readyz' }
      },
      {
        provider: 'claude',
        cli: { command: 'claude', available: true, path: '/usr/local/bin/claude' },
        accounts: { total: 0, source: 'readyz' }
      },
      {
        provider: 'agy',
        cli: { command: 'agy', available: true, path: '/usr/local/bin/agy' },
        accounts: {
          total: 1,
          available: 0,
          unavailable: 1,
          source: 'runtime_accounts',
          reasons: [{ reason: 'blocked_by_runtime_status:agy_not_signed_in', count: 1, sampleAccountIds: ['7'] }]
        }
      }
    ]
  }, {
    ...deps,
    ownerDeviceId: 'device-aws-current'
  });

  assert.equal(touched.runtimeDiagnostics.length, 3);
  const registry = listFabricRegistry(deps);
  const node = registry.nodeInventory.find((item) => item.id === 'aws-current-node');
  assert.ok(node);
  assert.deepEqual(
    node.runtimeGaps.map((gap) => `${gap.provider}:${gap.blocker}`),
    [
      'codex:missing_provider_cli:codex',
      'claude:missing_provider_account:claude',
      'agy:provider_account_unavailable:agy',
      'opencode:missing_provider_runtime:opencode'
    ]
  );
  assert.deepEqual(node.runtimeGaps.find((gap) => gap.provider === 'agy').diagnostic.accounts.reasons, [
    { reason: 'blocked_by_runtime_status:agy_not_signed_in', count: 1, sampleAccountIds: ['7'] }
  ]);
  assert.deepEqual(
    node.actions.find((action) => action.id === 'start-session:codex').blockers,
    ['missing_provider_cli:codex']
  );
  assert.deepEqual(
    node.actions.find((action) => action.id === 'start-session:claude').blockers,
    ['missing_provider_account:claude']
  );
  assert.deepEqual(
    node.actions.find((action) => action.id === 'start-session:agy').blockers,
    ['provider_account_unavailable:agy']
  );
});

test('fabric role registry heartbeat preserves WebRTC promotion evidence and mirrors legacy capability', (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-fabric-webrtc-promotion-'));
  let now = 1000;
  const deps = { fs, aiHomeDir, now: () => now };
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  registerFabricNode({
    node: {
      id: 'aws-current-node',
      name: 'AWS Current Node',
      roles: ['node', 'relay-node'],
      ownerDeviceId: 'device-aws-current'
    },
    transports: [
      { id: 'aws-current-node-relay', kind: 'relay', health: 'online', priority: 100 },
      {
        id: 'aws-current-node-webrtc',
        kind: 'webrtc',
        endpoint: 'http://control.example.com:9527',
        health: 'online',
        priority: 1,
        promotion: {
          remoteRequestReady: true,
          mode: 'direct',
          evidenceRef: 'docs/fabric/evidence/2026-06-29-m6-direct-webrtc-promotion.md',
          rttP95Ms: 201,
          rpcP95Ms: 200,
          promotedAt: 1782691200000
        }
      }
    ]
  }, deps);

  now = 2000;
  const touched = heartbeatFabricNode({
    node: {
      id: 'aws-current-node',
      status: 'online'
    },
    transports: [
      {
        kind: 'webrtc',
        health: 'online'
      }
    ]
  }, {
    ...deps,
    ownerDeviceId: 'device-aws-current'
  });

  const fabricWebrtc = touched.registry.transports.find((transport) => transport.kind === 'webrtc');
  assert.equal(fabricWebrtc.promotion.remoteRequestReady, true);
  assert.equal(fabricWebrtc.promotion.mode, 'direct');
  assert.equal(fabricWebrtc.promotion.evidenceRef, 'docs/fabric/evidence/2026-06-29-m6-direct-webrtc-promotion.md');

  const legacyWebrtc = listNodeTransports('aws-current-node', deps).find((transport) => transport.kind === 'webrtc');
  assert.equal(legacyWebrtc.promotion.remoteRequestReady, true);
  assert.equal(transportSupportsRemoteRequest(legacyWebrtc), true);
});

test('fabric role registry register preserves active WebRTC promotion across full node publish', (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-fabric-register-promotion-'));
  let now = 1000;
  const deps = { fs, aiHomeDir, now: () => now };
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  registerFabricNode({
    node: {
      id: 'aws-current-node',
      name: 'AWS Current Node',
      roles: ['node', 'relay-node'],
      ownerDeviceId: 'device-aws-current'
    },
    transports: [
      { id: 'aws-current-node-relay', kind: 'relay', health: 'online', priority: 100 },
      {
        id: 'aws-current-node-webrtc',
        kind: 'webrtc',
        endpoint: 'webrtc://aws-current-node',
        health: 'online',
        priority: 1,
        promotion: {
          remoteRequestReady: true,
          mode: 'direct',
          evidenceRef: 'docs/fabric/evidence/2026-06-29-m6-direct-webrtc-promotion.md',
          rttP95Ms: 201,
          rpcP95Ms: 200,
          promotedAt: 1000,
          expiresAt: Date.now() + 86_400_000
        }
      }
    ]
  }, deps);

  now = 2000;
  const updated = registerFabricNode({
    node: {
      id: 'aws-current-node',
      name: 'AWS Current Node',
      roles: ['node', 'relay-node'],
      ownerDeviceId: 'device-aws-current'
    },
    transports: [
      { id: 'aws-current-node-relay', kind: 'relay', health: 'online', priority: 100 },
      {
        id: 'aws-current-node-webrtc',
        kind: 'webrtc',
        endpoint: 'webrtc://aws-current-node',
        health: 'online',
        priority: 1
      }
    ],
    runtimes: [
      { provider: 'opencode', mode: 'tui', version: 'latest' }
    ]
  }, deps);

  const returnedWebrtc = updated.transports.find((transport) => transport.kind === 'webrtc');
  assert.equal(returnedWebrtc.promotion.remoteRequestReady, true);
  assert.equal(returnedWebrtc.promotion.mode, 'direct');
  assert.equal(returnedWebrtc.promotion.evidenceRef, 'docs/fabric/evidence/2026-06-29-m6-direct-webrtc-promotion.md');

  const fabricWebrtc = listFabricRegistry(deps).transports.find((transport) => transport.kind === 'webrtc');
  assert.equal(fabricWebrtc.promotion.remoteRequestReady, true);
  assert.equal(fabricWebrtc.promotion.rpcP95Ms, 200);

  const legacyWebrtc = listNodeTransports('aws-current-node', deps).find((transport) => transport.kind === 'webrtc');
  assert.equal(legacyWebrtc.promotion.remoteRequestReady, true);
  assert.equal(transportSupportsRemoteRequest(legacyWebrtc), true);
});

test('fabric role registry mirror clears stale legacy WebRTC promotion when fabric transport is not promoted', (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-fabric-clear-legacy-promotion-'));
  const deps = { fs, aiHomeDir, now: () => 3000 };
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  upsertRemoteTransport({
    id: 'aws-current-node-webrtc',
    nodeId: 'aws-current-node',
    kind: 'webrtc',
    endpoint: 'http://control.example.com:9527',
    status: 'up',
    score: 88,
    promotion: {
      remoteRequestReady: true,
      mode: 'direct',
      evidenceRef: 'docs/fabric/evidence/stale.md',
      promotedAt: 1000
    }
  }, deps);

  registerFabricNode({
    node: {
      id: 'aws-current-node',
      name: 'AWS Current Node',
      roles: ['node', 'relay-node'],
      ownerDeviceId: 'device-aws-current'
    },
    transports: [
      { id: 'aws-current-node-relay', kind: 'relay', health: 'online', priority: 100 },
      {
        id: 'aws-current-node-webrtc',
        kind: 'webrtc',
        endpoint: 'webrtc://aws-current-node',
        health: 'online',
        priority: 1
      }
    ]
  }, deps);

  const legacyWebrtc = listNodeTransports('aws-current-node', deps).find((transport) => transport.kind === 'webrtc');
  assert.equal(legacyWebrtc.promotion, undefined);
  assert.equal(transportSupportsRemoteRequest(legacyWebrtc), false);
});

test('fabric role registry heartbeat preserves runtime WebRTC RPC promotion in legacy mirror', (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-fabric-runtime-promotion-'));
  let now = 1000;
  const deps = { fs, aiHomeDir, now: () => now };
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  registerFabricNode({
    node: {
      id: 'aws-current-node',
      name: 'AWS Current Node',
      roles: ['node', 'relay-node'],
      ownerDeviceId: 'device-aws-current'
    },
    transports: [
      { id: 'aws-current-node-relay', kind: 'relay', health: 'online', priority: 100 },
      {
        id: 'aws-current-node-webrtc',
        kind: 'webrtc',
        endpoint: 'http://control.example.com:9527',
        health: 'online',
        priority: 1,
        promotion: {
          remoteRequestReady: true,
          mode: 'direct',
          evidenceRef: 'docs/fabric/evidence/stale-direct.md',
          rttP95Ms: 302.6,
          rpcP95Ms: 302.6,
          promotedAt: 1000,
          expiresAt: Date.now() + 43_200_000
        }
      }
    ]
  }, deps);

  upsertRemoteTransport({
    id: 'aws-current-node-webrtc',
    nodeId: 'aws-current-node',
    kind: 'webrtc',
    endpoint: 'http://control.example.com:9527',
    status: 'up',
    score: 88,
    promotion: {
      remoteRequestReady: true,
      mode: 'management-rpc',
      evidenceRef: 'runtime:webrtc-management-rpc:/v0/node-rpc/status',
      rttP95Ms: 0,
      rpcP95Ms: 169,
      promotedAt: 2000,
      expiresAt: Date.now() + 86_400_000
    }
  }, deps);

  now = 3000;
  heartbeatFabricNode({
    node: {
      id: 'aws-current-node',
      status: 'online'
    },
    transports: [
      {
        kind: 'webrtc',
        health: 'online'
      }
    ]
  }, {
    ...deps,
    ownerDeviceId: 'device-aws-current'
  });

  const legacyWebrtc = listNodeTransports('aws-current-node', deps).find((transport) => transport.kind === 'webrtc');
  assert.equal(legacyWebrtc.promotion.remoteRequestReady, true);
  assert.equal(legacyWebrtc.promotion.mode, 'management-rpc');
  assert.equal(legacyWebrtc.promotion.rpcP95Ms, 169);
  assert.equal(transportSupportsRemoteRequest(legacyWebrtc), true);
});

test('fabric role registry heartbeat bootstraps missing node liveness only', (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-fabric-role-heartbeat-bootstrap-'));
  const deps = { fs, aiHomeDir, now: () => 7000 };
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  const touched = heartbeatFabricNode({
    node: {
      id: 'aws-current-node',
      status: 'online'
    },
    relayNode: {
      status: 'online'
    },
    transports: [
      {
        kind: 'relay',
        health: 'online',
        measurement: {
          status: 'ws_echo_pass',
          durationMs: 31,
          successes: 20,
          failures: 0,
          sampleCount: 20,
          successRate: 1
        }
      }
    ]
  }, {
    ...deps,
    ownerDeviceId: 'device-aws-current'
  });

  assert.equal(touched.node.id, 'aws-current-node');
  assert.equal(touched.node.ownerDeviceId, 'device-aws-current');
  assert.deepEqual(touched.node.roles, ['node', 'relay-node']);
  assert.equal(touched.node.lastSeenAt, 7000);
  assert.equal(touched.relayNode.status, 'online');
  assert.equal(touched.transports.length, 1);
  assert.equal(touched.transports[0].endpoint, 'relay://aws-current-node');
  assert.deepEqual(touched.registry.counts, {
    nodes: 1,
    relayNodes: 1,
    transports: 1,
    projects: 0,
    runtimes: 0
  });
  assert.equal(touched.registry.networkMeasurements.length, 1);

  const registry = listFabricRegistry(deps);
  assert.equal(registry.nodes[0].id, 'aws-current-node');
  assert.equal(registry.projects.length, 0);
  assert.equal(registry.runtimes.length, 0);

  const legacyNode = getRemoteNode('aws-current-node', deps);
  assert.equal(legacyNode.role, 'relay-node');
  const legacyTransports = listNodeTransports('aws-current-node', deps);
  assert.equal(legacyTransports[0].status, 'up');
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
