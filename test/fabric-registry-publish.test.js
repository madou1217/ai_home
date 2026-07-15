const test = require('node:test');
const assert = require('node:assert/strict');

const { runFabricCommandRouter } = require('../lib/cli/commands/fabric-router');
const {
  buildPublishPayload,
  deriveRuntimeSnapshotsFromAccounts,
  formatFabricRegistryPublishReport,
  parseFabricRegistryPublishArgs,
  runFabricRegistryPublish
} = require('../lib/cli/services/fabric/registry-publish');

test('parseFabricRegistryPublishArgs builds a node snapshot from explicit CLI inputs', () => {
  const options = parseFabricRegistryPublishArgs([
    'https://server.example.com/',
    '--management-key',
    'management-secret',
    '--node-id',
    'Home Mac',
    '--name',
    'Home Mac',
    '--relay-node',
    '--bandwidth-kbps',
    '2048',
    '--project',
    './repo',
    '--runtime',
    'codex:tui:0.142.0',
    '--transport',
    'wss=wss://server.example.com/fabric',
    '--json'
  ], {
    cwd: () => '/Users/model/projects',
    hostname: () => 'host.local',
    env: {}
  });

  assert.equal(options.endpoint, 'https://server.example.com');
  assert.equal(options.managementKey, 'management-secret');
  assert.equal(options.nodeId, 'home-mac');
  assert.equal(options.name, 'Home Mac');
  assert.deepEqual(options.roles, ['node', 'relay-node']);
  assert.equal(options.relayNode.bandwidthLimitKbps, 2048);
  assert.equal(options.projects[0].path, '/Users/model/projects/repo');
  assert.deepEqual(options.runtimes[0], {
    provider: 'codex',
    mode: 'tui',
    version: '0.142.0'
  });
  assert.deepEqual(options.transports[0], {
    id: 'home-mac-wss',
    kind: 'wss',
    endpoint: 'wss://server.example.com/fabric'
  });
  assert.equal(options.json, true);
});

test('deriveRuntimeSnapshotsFromAccounts uses real management account providers', () => {
  const runtimes = deriveRuntimeSnapshotsFromAccounts([
    { provider: 'codex', status: 'up', runtimeStatus: 'healthy', schedulableStatus: 'schedulable' },
    { provider: 'codex', status: 'up', runtimeStatus: 'healthy', schedulableStatus: 'blocked_by_policy' },
    { provider: 'gemini', status: 'up', runtimeStatus: 'healthy', schedulableStatus: 'schedulable' },
    { provider: 'claude', status: 'down', runtimeStatus: 'healthy', schedulableStatus: 'schedulable' },
    { provider: 'agy', status: 'up', runtimeStatus: 'auth_invalid', schedulableStatus: 'schedulable' },
    { provider: 'unknown', status: 'up', runtimeStatus: 'healthy', schedulableStatus: 'schedulable' }
  ]);

  assert.deepEqual(runtimes.map((runtime) => runtime.provider), ['codex', 'gemini', 'claude', 'agy']);
  assert.deepEqual(runtimes.map((runtime) => runtime.mode), ['api', 'api', 'api', 'api']);
  assert.deepEqual(runtimes.find((runtime) => runtime.provider === 'codex').capabilities, ['accounts:2', 'schedulable:1']);
  assert.equal(runtimes.find((runtime) => runtime.provider === 'gemini').status, 'available');
  assert.equal(runtimes.find((runtime) => runtime.provider === 'claude').status, 'degraded');
  assert.equal(runtimes.find((runtime) => runtime.provider === 'agy').status, 'degraded');
});

test('runFabricRegistryPublish posts registry snapshot with Management Key', async () => {
  const requests = [];
  const result = await runFabricRegistryPublish([
    'http://127.0.0.1:8317',
    '--management-key',
    'secret-token',
    '--node-id',
    'office-pc',
    '--project',
    '/workspace/app',
    '--runtime',
    'claude:tui',
    '--relay-node',
    '--json'
  ], {
    cwd: () => '/workspace/app',
    env: {},
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          result: {
            node: { id: 'office-pc' },
            registry: { counts: { nodes: 1 } }
          }
        })
      };
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.nodeId, 'office-pc');
  assert.equal(result.projects, 1);
  assert.equal(result.runtimes, 1);
  assert.equal(result.transports, 1);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'http://127.0.0.1:8317/v0/fabric/registry/nodes');
  assert.equal(requests[0].options.headers.authorization, 'Bearer secret-token');
  const body = JSON.parse(requests[0].options.body);
  assert.equal(body.node.id, 'office-pc');
  assert.deepEqual(body.node.roles, ['node', 'relay-node']);
  assert.deepEqual(body.node.capabilities, [
    'status',
    'metrics',
    'accounts',
    'models',
    'usage',
    'projects',
    'runtimes',
    'sessions'
  ]);
  assert.equal(body.projects[0].path, '/workspace/app');
  assert.equal(body.runtimes[0].provider, 'claude');
  assert.equal(body.transports[0].kind, 'relay');
});

test('runFabricRegistryPublish can derive runtimes from real server management accounts', async () => {
  const requests = [];
  const result = await runFabricRegistryPublish([
    'http://127.0.0.1:8317',
    '--management-key',
    'management-secret',
    '--management-key',
    'management-secret',
    '--node-id',
    'real-vps',
    '--project',
    '/opt/app',
    '--from-server',
    '--relay-node',
    '--json'
  ], {
    cwd: () => '/opt/app',
    env: {},
    fetchImpl: async (url, options = {}) => {
      requests.push({ url, options });
      if (url === 'http://127.0.0.1:8317/v0/management/accounts') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            accounts: [
              { provider: 'codex', status: 'up', runtimeStatus: 'healthy', schedulableStatus: 'schedulable' },
              { provider: 'gemini', status: 'up', runtimeStatus: 'healthy', schedulableStatus: 'schedulable' },
              { provider: 'claude', status: 'up', runtimeStatus: 'healthy', schedulableStatus: 'schedulable' },
              { provider: 'agy', status: 'up', runtimeStatus: 'healthy', schedulableStatus: 'schedulable' }
            ]
          })
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          result: {
            node: { id: 'real-vps' },
            registry: { counts: { nodes: 1, runtimes: 4 } }
          }
        })
      };
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.runtimes, 4);
  assert.equal(result.fromServer.accounts, 4);
  assert.deepEqual(result.fromServer.providers, ['agy', 'claude', 'codex', 'gemini']);
  assert.equal(requests[0].url, 'http://127.0.0.1:8317/v0/management/accounts');
  assert.equal(requests[0].options.headers.authorization, 'Bearer management-secret');
  assert.equal(requests[1].url, 'http://127.0.0.1:8317/v0/fabric/registry/nodes');
  assert.equal(requests[1].options.headers.authorization, 'Bearer management-secret');
  const body = JSON.parse(requests[1].options.body);
  assert.deepEqual(body.runtimes.map((runtime) => `${runtime.provider}:${runtime.mode}`), [
    'codex:api',
    'gemini:api',
    'claude:api',
    'agy:api'
  ]);
});

test('buildPublishPayload and formatter keep output compact', () => {
  const options = parseFabricRegistryPublishArgs([
    'https://server.example.com',
    '--management-key',
    'token',
    '--node-id',
    'home',
    '--runtime',
    'gemini:api',
    '--runtime',
    'opencode:tui'
  ], {
    cwd: () => '/workspace/home',
    env: {}
  });
  const payload = buildPublishPayload(options);
  assert.equal(payload.node.id, 'home');
  assert.deepEqual(payload.node.capabilities, [
    'status',
    'metrics',
    'accounts',
    'models',
    'usage',
    'projects',
    'runtimes',
    'sessions'
  ]);
  assert.equal(payload.projects[0].name, 'home');
  assert.deepEqual(payload.runtimes.map((runtime) => runtime.provider), ['gemini', 'opencode']);

  const report = formatFabricRegistryPublishReport({
    ok: true,
    endpoint: 'https://server.example.com',
    nodeId: 'home',
    roles: ['node'],
    projects: 1,
    runtimes: 1,
    transports: 0
  });
  assert.match(report, /AIH Fabric registry publish/);
  assert.match(report, /node: home/);
  assert.match(report, /status: registered/);
});

test('runFabricCommandRouter routes registry publish JSON', async () => {
  const writes = [];
  const exits = [];

  await runFabricCommandRouter([
    'fabric',
    'registry',
    'publish',
    'https://server.example.com',
    '--management-key',
    'token',
    '--node-id',
    'home',
    '--json'
  ], {
    processObj: {
      stdout: { write: (value) => writes.push(String(value)) },
      exit: (code) => exits.push(code)
    },
    consoleImpl: {
      log: () => {},
      error: () => {}
    },
    runFabricRegistryPublish: async (args) => ({
      ok: true,
      json: args.includes('--json'),
      endpoint: 'https://server.example.com',
      nodeId: 'home',
      roles: ['node'],
      projects: 1,
      runtimes: 0,
      transports: 0,
      result: { node: { id: 'home' } }
    })
  });

  assert.deepEqual(exits, [0]);
  const payload = JSON.parse(writes.join(''));
  assert.equal(payload.ok, true);
  assert.equal(payload.nodeId, 'home');
  assert.equal(payload.result.node.id, 'home');
});
