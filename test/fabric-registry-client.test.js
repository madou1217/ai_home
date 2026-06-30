const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('../web/node_modules/typescript');

function compileTypeScript(filename) {
  const source = fs.readFileSync(filename, 'utf8');
  return ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true
    }
  }).outputText;
}

function installTsRequireHook() {
  const previous = require.extensions['.ts'];
  require.extensions['.ts'] = (mod, filename) => {
    mod._compile(compileTypeScript(filename), filename);
  };
  return () => {
    if (previous) {
      require.extensions['.ts'] = previous;
      return;
    }
    delete require.extensions['.ts'];
  };
}

function loadFabricRegistryModule() {
  const filename = path.join(__dirname, '../web/src/services/fabric-registry.ts');
  const restore = installTsRequireHook();
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = Module._nodeModulePaths(path.dirname(filename));
  try {
    mod._compile(compileTypeScript(filename), filename);
    return mod.exports;
  } finally {
    restore();
  }
}

test('normalizeFabricRegistryResult builds stable registry and node views', () => {
  const fabric = loadFabricRegistryModule();
  const registry = fabric.normalizeFabricRegistryResult({
    ok: true,
    result: {
      nodes: [{
        id: 'home-mac',
        name: 'Home Mac',
        roles: ['node', 'relay-node'],
        platform: 'darwin',
        arch: 'arm64',
        status: 'online',
        lastSeenAt: 1000
      }],
      relayNodes: [{
        id: 'home-mac-relay',
        nodeId: 'home-mac',
        capacityClass: 'tiny',
        bandwidthLimitKbps: 2048,
        status: 'online'
      }],
      transports: [{
        id: 'home-mac-relay',
        nodeId: 'home-mac',
        ownerId: 'home-mac-relay',
        kind: 'relay',
        health: 'online',
        measurement: {
          status: 'tcp_echo_pass',
          durationMs: 12,
          successes: 1,
          failures: 0,
          sampleCount: 5,
          successRate: 1,
          measuredAt: 2000,
          rttMs: { min: 12, p50: 12, p95: 12, max: 12, avg: 12 }
        }
      }],
      projects: [{
        id: 'home-mac-p',
        nodeId: 'home-mac',
        name: 'ai_home',
        displayPath: '/Users/model/projects/feature/ai_home'
      }],
      runtimes: [{
        id: 'home-mac-codex-tui',
        nodeId: 'home-mac',
        provider: 'codex',
        mode: 'tui',
        status: 'available'
      }],
      networkMeasurements: [{
        id: 'nm-home-mac-relay-1',
        nodeId: 'home-mac',
        transportId: 'home-mac-relay',
        transportKind: 'relay',
        ownerType: 'relay-node',
        ownerId: 'home-mac-relay',
        status: 'tcp_echo_pass',
        durationMs: 12,
        successes: 1,
        failures: 0,
        sampleCount: 5,
        successRate: 1,
        measuredAt: 2000,
        createdAt: 2000,
        rttMs: { min: 12, p50: 12, p95: 12, max: 12, avg: 12, count: 5 }
      }]
    }
  });

  assert.deepEqual(registry.counts, {
    nodes: 1,
    relayNodes: 1,
    transports: 1,
    projects: 1,
    runtimes: 1
  });
  assert.equal(registry.nodes[0].name, 'Home Mac');
  assert.equal(registry.relayNodes[0].bandwidthLimitKbps, 2048);
  assert.equal(registry.networkMeasurements.length, 1);
  assert.equal(registry.networkMeasurements[0].transportId, 'home-mac-relay');
  assert.equal(registry.networkMeasurements[0].successRate, 1);
  assert.deepEqual(registry.transports[0].measurement, {
    status: 'tcp_echo_pass',
    durationMs: 12,
    successes: 1,
    failures: 0,
    sampleCount: 5,
    successRate: 1,
    failureReason: '',
    measuredAt: 2000,
    rttMs: { min: 12, p50: 12, p95: 12, max: 12, avg: 12, count: 0 }
  });

  const nodeViews = fabric.buildFabricRegistryNodeViews(registry);
  assert.equal(nodeViews.length, 1);
  assert.equal(nodeViews[0].projects[0].name, 'ai_home');
  assert.equal(nodeViews[0].runtimes[0].provider, 'codex');
  assert.equal(nodeViews[0].relayNode.id, 'home-mac-relay');
  assert.equal(registry.nodeInventory.length, 1);
  assert.equal(registry.nodeInventory[0].capabilities.runtimeHost, true);
  assert.equal(registry.nodeInventory[0].actions.find((action) => action.id === 'start-session:codex').eligible, true);
  assert.equal(registry.nodeInventory[0].actions.find((action) => action.id === 'start-session:codex').enabled, true);
  assert.deepEqual(
    registry.nodeInventory[0].actions.find((action) => action.id === 'start-session:codex').blockers,
    []
  );

  const relayViews = fabric.buildFabricRegistryRelayViews(registry);
  assert.equal(relayViews.length, 1);
  assert.equal(relayViews[0].node.name, 'Home Mac');
  assert.equal(relayViews[0].health, 'online');
});

test('buildFabricRegistryRelayViews keeps unmeasured relay health pending', () => {
  const fabric = loadFabricRegistryModule();
  const registry = fabric.normalizeFabricRegistryResult({
    result: {
      nodes: [{ id: 'home-mac', name: 'Home Mac' }],
      relayNodes: [{ id: 'home-mac-relay', nodeId: 'home-mac', enabled: true }],
      transports: [{ id: 'home-mac-relay', nodeId: 'home-mac', ownerId: 'home-mac-relay', kind: 'relay', health: 'unknown' }]
    }
  });

  const relayViews = fabric.buildFabricRegistryRelayViews(registry);
  assert.equal(relayViews[0].health, 'pending-measurement');
});

test('normalizeFabricRegistryResult falls back to node inventory when server omits it', () => {
  const fabric = loadFabricRegistryModule();
  const registry = fabric.normalizeFabricRegistryResult({
    result: {
      nodes: [
        { id: 'aws-current-node', name: 'AWS Current Node', roles: ['node', 'relay-node'], status: 'online' },
        { id: 'local-mac-remote-node', name: 'Local Mac Remote Node', roles: ['node', 'relay-node'], status: 'online' }
      ],
      relayNodes: [
        { id: 'aws-current-node-relay', nodeId: 'aws-current-node', enabled: true, status: 'online' },
        { id: 'local-mac-remote-node-relay', nodeId: 'local-mac-remote-node', enabled: true, status: 'online' }
      ],
      projects: [
        { id: 'aws-project', nodeId: 'aws-current-node', name: 'aih-fabric-current' },
        { id: 'local-project', nodeId: 'local-mac-remote-node', name: 'ai_home' }
      ],
      runtimes: [
        { id: 'local-codex', nodeId: 'local-mac-remote-node', provider: 'codex', mode: 'tui', status: 'available' },
        { id: 'local-claude', nodeId: 'local-mac-remote-node', provider: 'claude', mode: 'tui', status: 'available' },
        { id: 'local-agy', nodeId: 'local-mac-remote-node', provider: 'agy', mode: 'tui', status: 'available' },
        { id: 'local-opencode', nodeId: 'local-mac-remote-node', provider: 'opencode', mode: 'tui', status: 'available' }
      ],
      transports: [
        { id: 'aws-current-node-relay', nodeId: 'aws-current-node', kind: 'relay', health: 'online' },
        { id: 'local-mac-remote-node-relay', nodeId: 'local-mac-remote-node', kind: 'relay', health: 'online' }
      ]
    }
  });

  const aws = registry.nodeInventory.find((node) => node.id === 'aws-current-node');
  const local = registry.nodeInventory.find((node) => node.id === 'local-mac-remote-node');
  assert.equal(aws.capabilities.runtimeHost, false);
  assert.deepEqual(
    aws.runtimeGaps.map((gap) => `${gap.provider}:${gap.blocker}`),
    [
      'codex:missing_provider_runtime:codex',
      'claude:missing_provider_runtime:claude',
      'agy:missing_provider_runtime:agy',
      'opencode:missing_provider_runtime:opencode'
    ]
  );
  assert.equal(aws.actions.find((action) => action.id === 'start-session:codex').blockers.includes('missing_provider_runtime:codex'), true);
  assert.deepEqual(local.capabilities.runtimeProviders, ['agy', 'claude', 'codex', 'opencode']);
  assert.deepEqual(local.runtimeGaps, []);
});

test('fetchFabricRegistry reads scoped registry with bearer token', async () => {
  const fabric = loadFabricRegistryModule();
  const requests = [];
  const result = await fabric.fetchFabricRegistry({
    endpoint: 'https://server.example.com',
    deviceToken: 'device-token'
  }, {
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          result: {
            nodes: [{ id: 'office-pc', name: 'Office PC' }],
            counts: { nodes: 1 }
          }
        })
      };
    }
  });

  assert.equal(result.nodes[0].id, 'office-pc');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://server.example.com/v0/fabric/registry');
  assert.equal(requests[0].options.headers.authorization, 'Bearer device-token');
});
