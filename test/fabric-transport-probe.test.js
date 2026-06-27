const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const {
  formatFabricTransportProbeReport,
  normalizeProbeTarget,
  parseFabricTransportProbeArgs,
  runFabricTransportProbe
} = require('../lib/cli/services/fabric/transport-probe');
const { runFabricCommandRouter } = require('../lib/cli/commands/fabric-router');

function createFakeNet(connectHandler) {
  return {
    createConnection(options) {
      const socket = new EventEmitter();
      socket.setTimeout = (timeoutMs) => {
        socket.timeoutMs = timeoutMs;
      };
      socket.destroy = () => {
        socket.destroyed = true;
      };
      queueMicrotask(() => connectHandler(socket, options));
      return socket;
    }
  };
}

test('normalizeProbeTarget classifies http websocket and tcp endpoints', () => {
  assert.deepEqual(normalizeProbeTarget('https://example.com:9443/health'), {
    raw: 'https://example.com:9443/health',
    kind: 'http',
    protocol: 'https',
    url: 'https://example.com:9443/health',
    host: 'example.com',
    port: 9443
  });

  assert.deepEqual(normalizeProbeTarget('wss://relay.example.com/v0/relay/node'), {
    raw: 'wss://relay.example.com/v0/relay/node',
    kind: 'tcp-upgrade',
    protocol: 'wss',
    url: 'wss://relay.example.com/v0/relay/node',
    host: 'relay.example.com',
    port: 443
  });

  assert.deepEqual(normalizeProbeTarget('155.248.183.169:22'), {
    raw: '155.248.183.169:22',
    kind: 'tcp',
    protocol: 'tcp',
    host: '155.248.183.169',
    port: 22,
    url: 'tcp://155.248.183.169:22'
  });
});

test('parseFabricTransportProbeArgs parses probe options and targets', () => {
  const options = parseFabricTransportProbeArgs([
    'https://server.example.com',
    'tcp://127.0.0.1:9527',
    '--timeout-ms',
    '2500',
    '--method=GET',
    '--json'
  ]);

  assert.equal(options.timeoutMs, 2500);
  assert.equal(options.httpMethod, 'GET');
  assert.equal(options.json, true);
  assert.equal(options.targets.length, 2);
  assert.equal(options.targets[0].kind, 'http');
  assert.equal(options.targets[1].kind, 'tcp');
});

test('runFabricTransportProbe returns structured http and tcp evidence', async () => {
  let now = 1000;
  const result = await runFabricTransportProbe([
    'https://server.example.com/health',
    'tcp://127.0.0.1:9527',
    '--timeout-ms',
    '1000',
    '--json'
  ], {
    now: () => {
      now += 7;
      return now;
    },
    fetchImpl: async (url, init) => {
      assert.equal(String(url), 'https://server.example.com/health');
      assert.equal(init.method, 'HEAD');
      return { status: 204, ok: true, redirected: false };
    },
    netImpl: createFakeNet((socket, options) => {
      assert.deepEqual(options, { host: '127.0.0.1', port: 9527 });
      socket.emit('connect');
    })
  });

  assert.equal(result.ok, true);
  assert.equal(result.json, true);
  assert.equal(result.probes.length, 2);
  assert.equal(result.probes[0].http.status, 204);
  assert.equal(result.probes[1].reachable, true);
  assert.equal(result.probes[1].status, 'reachable');
});

test('runFabricTransportProbe marks tcp errors without throwing', async () => {
  const result = await runFabricTransportProbe(['tcp://127.0.0.1:1'], {
    now: () => 1000,
    netImpl: createFakeNet((socket) => {
      const error = new Error('refused');
      error.code = 'ECONNREFUSED';
      socket.emit('error', error);
    })
  });

  assert.equal(result.ok, false);
  assert.equal(result.probes[0].reachable, false);
  assert.equal(result.probes[0].error, 'ECONNREFUSED');
});

test('runFabricTransportProbe separates http network reachability from service health', async () => {
  const result = await runFabricTransportProbe(['https://server.example.com/missing'], {
    now: () => 1000,
    fetchImpl: async () => ({ status: 404, ok: false, redirected: false })
  });

  assert.equal(result.ok, true);
  assert.equal(result.probes[0].reachable, true);
  assert.equal(result.probes[0].networkReachable, true);
  assert.equal(result.probes[0].serviceHealthy, false);
  assert.equal(result.probes[0].http.status, 404);
});

test('formatFabricTransportProbeReport renders human-readable evidence', () => {
  const text = formatFabricTransportProbeReport({
    ok: false,
    generatedAt: '2026-06-26T00:00:00.000Z',
    timeoutMs: 1000,
    probes: [
      { reachable: true, normalizedTarget: 'https://a.example', durationMs: 10, http: { status: 200 } },
      { reachable: false, normalizedTarget: 'tcp://b.example:22', durationMs: 1000, error: 'connect_timeout' }
    ]
  });

  assert.match(text, /fabric transport probe/);
  assert.match(text, /ok https:\/\/a\.example 10ms http=200 service=unhealthy/);
  assert.match(text, /fail tcp:\/\/b\.example:22 1000ms error=connect_timeout/);
  assert.match(text, /result: fail/);
});

test('runFabricCommandRouter routes transport probe JSON', async () => {
  const writes = [];
  const exits = [];

  await runFabricCommandRouter([
    'fabric',
    'transport',
    'probe',
    'tcp://127.0.0.1:9527',
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
    runFabricTransportProbe: async (args) => ({
      ok: true,
      json: args.includes('--json'),
      generatedAt: '2026-06-26T00:00:00.000Z',
      command: 'aih fabric transport probe',
      timeoutMs: 5000,
      httpMethod: 'HEAD',
      probes: [{ reachable: true, normalizedTarget: 'tcp://127.0.0.1:9527' }]
    })
  });

  assert.deepEqual(exits, [0]);
  const payload = JSON.parse(writes.join(''));
  assert.equal(payload.ok, true);
  assert.equal(payload.probes[0].normalizedTarget, 'tcp://127.0.0.1:9527');
});
