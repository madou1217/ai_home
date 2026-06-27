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
        health: 'unknown'
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

  const nodeViews = fabric.buildFabricRegistryNodeViews(registry);
  assert.equal(nodeViews.length, 1);
  assert.equal(nodeViews[0].projects[0].name, 'ai_home');
  assert.equal(nodeViews[0].runtimes[0].provider, 'codex');
  assert.equal(nodeViews[0].relayNode.id, 'home-mac-relay');

  const relayViews = fabric.buildFabricRegistryRelayViews(registry);
  assert.equal(relayViews.length, 1);
  assert.equal(relayViews[0].node.name, 'Home Mac');
  assert.equal(relayViews[0].health, 'pending-measurement');
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
