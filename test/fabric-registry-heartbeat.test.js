const test = require('node:test');
const assert = require('node:assert/strict');

const { runFabricCommandRouter } = require('../lib/cli/commands/fabric-router');
const {
  buildHeartbeatPayload,
  formatTransportHeartbeat,
  parseFabricRegistryHeartbeatArgs,
  parseTransportHeartbeat,
  runFabricRegistryHeartbeat
} = require('../lib/cli/services/fabric/registry-heartbeat');

test('parseFabricRegistryHeartbeatArgs builds heartbeat from CLI inputs', () => {
  const options = parseFabricRegistryHeartbeatArgs([
    'http://127.0.0.1:8317/',
    '--token',
    'device-token',
    '--node-id',
    'Home Mac',
    '--status',
    'online',
    '--relay-status',
    'degraded',
    '--transport',
    'relay=degraded,rtt_high',
    '--json'
  ], { env: {} });

  assert.equal(options.endpoint, 'http://127.0.0.1:8317');
  assert.equal(options.token, 'device-token');
  assert.equal(options.nodeId, 'home-mac');
  assert.equal(options.status, 'online');
  assert.equal(options.relayStatus, 'degraded');
  assert.deepEqual(options.transports, [
    { kind: 'relay', health: 'degraded', lastError: 'rtt_high' }
  ]);
  assert.equal(options.json, true);
});

test('parseTransportHeartbeat accepts colon shorthand', () => {
  assert.deepEqual(parseTransportHeartbeat('wss:online'), {
    kind: 'wss',
    health: 'online',
    lastError: ''
  });
});

test('parseTransportHeartbeat preserves WebRTC promotion evidence', () => {
  const transport = parseTransportHeartbeat([
    'webrtc=online',
    'promotion=ready',
    'mode=direct',
    'evidence-ref=docs/fabric/evidence/2026-06-29-m6-direct-webrtc-promotion.md',
    'rtt-p95-ms=201',
    'rpc-p95-ms=200',
    'promoted-at=1782691200000',
    'expires-at=1783296000000'
  ].join(','));

  assert.deepEqual(transport, {
    kind: 'webrtc',
    health: 'online',
    lastError: '',
    promotion: {
      remoteRequestReady: true,
      mode: 'direct',
      evidenceRef: 'docs/fabric/evidence/2026-06-29-m6-direct-webrtc-promotion.md',
      rttP95Ms: 201,
      rpcP95Ms: 200,
      promotedAt: 1782691200000,
      expiresAt: 1783296000000
    }
  });

  assert.equal(formatTransportHeartbeat(transport), [
    'webrtc=online',
    'remote-request-ready=true',
    'mode=direct',
    'evidence-ref=docs/fabric/evidence/2026-06-29-m6-direct-webrtc-promotion.md',
    'rtt-p95-ms=201',
    'rpc-p95-ms=200',
    'promoted-at=1782691200000',
    'expires-at=1783296000000'
  ].join(','));
});

test('runFabricRegistryHeartbeat posts liveness without credentials in payload', async () => {
  const requests = [];
  const result = await runFabricRegistryHeartbeat([
    'https://server.example.com',
    '--token',
    'secret-token',
    '--node-id',
    'office-pc',
    '--relay-status',
    'online',
    '--transport',
    'relay=online',
    '--json'
  ], {
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
            registry: { counts: { nodes: 1, projects: 1, runtimes: 2 } }
          }
        })
      };
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.nodeId, 'office-pc');
  assert.equal(result.transports, 1);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://server.example.com/v0/fabric/registry/heartbeat');
  assert.equal(requests[0].options.headers.authorization, 'Bearer secret-token');
  const body = JSON.parse(requests[0].options.body);
  assert.deepEqual(body, {
    node: { id: 'office-pc', status: 'online' },
    relayNode: { status: 'online' },
    transports: [{ kind: 'relay', health: 'online', lastError: '' }]
  });
  assert.equal(JSON.stringify(body).includes('secret-token'), false);
});

test('buildHeartbeatPayload omits relay when not requested', () => {
  const payload = buildHeartbeatPayload({
    nodeId: 'home',
    status: 'online',
    relayStatus: '',
    transports: []
  });
  assert.deepEqual(payload, {
    node: { id: 'home', status: 'online' },
    relayNode: undefined,
    transports: []
  });
});

test('buildHeartbeatPayload preserves transport measurement summaries', () => {
  const payload = buildHeartbeatPayload({
    nodeId: 'home',
    status: 'online',
    relayStatus: 'online',
    transports: [{
      kind: 'relay',
      health: 'online',
      lastError: '',
      measurement: {
        status: 'tcp_echo_pass',
        durationMs: 12,
        successes: 1,
        failures: 0,
        rttMs: { p95: 12 }
      }
    }]
  });
  assert.deepEqual(payload, {
    node: { id: 'home', status: 'online' },
    relayNode: { status: 'online' },
    transports: [{
      kind: 'relay',
      health: 'online',
      lastError: '',
      measurement: {
        status: 'tcp_echo_pass',
        durationMs: 12,
        successes: 1,
        failures: 0,
        rttMs: { p95: 12 }
      }
    }]
  });
});

test('buildHeartbeatPayload includes runtime diagnostics only when provided', () => {
  const payload = buildHeartbeatPayload({
    nodeId: 'aws-current-node',
    status: 'online',
    relayStatus: '',
    transports: [],
    runtimeDiagnostics: [
      {
        provider: 'codex',
        cli: { command: 'codex', available: false },
        accounts: { total: 0, source: 'readyz' }
      }
    ]
  });
  assert.deepEqual(payload, {
    node: { id: 'aws-current-node', status: 'online' },
    relayNode: undefined,
    transports: [],
    runtimeDiagnostics: [
      {
        provider: 'codex',
        cli: { command: 'codex', available: false },
        accounts: { total: 0, source: 'readyz' }
      }
    ]
  });
});

test('runFabricCommandRouter routes registry heartbeat JSON', async () => {
  const writes = [];
  const exits = [];

  await runFabricCommandRouter([
    'fabric',
    'registry',
    'heartbeat',
    'https://server.example.com',
    '--token',
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
    runFabricRegistryHeartbeat: async (args) => ({
      ok: true,
      json: args.includes('--json'),
      endpoint: 'https://server.example.com',
      nodeId: 'home',
      status: 'online',
      relayStatus: '',
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
