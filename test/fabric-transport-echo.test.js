const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');

const {
  closeEchoServer,
  formatFabricTransportEchoReport,
  parseFabricTransportEchoArgs,
  parseFabricTransportEchoServerArgs,
  runFabricTransportEcho,
  startFabricTransportEchoServer,
  summarizeRtt
} = require('../lib/cli/services/fabric/transport-echo');
const { runFabricCommandRouter } = require('../lib/cli/commands/fabric-router');

test('parseFabricTransportEchoArgs parses websocket benchmark options', () => {
  const options = parseFabricTransportEchoArgs([
    'ws://127.0.0.1:8765/echo',
    '--count',
    '20',
    '--payload-size=512',
    '--interval-ms',
    '5',
    '--timeout-ms',
    '2000',
    '--insecure',
    '--json'
  ]);

  assert.equal(options.target.toString(), 'ws://127.0.0.1:8765/echo');
  assert.equal(options.count, 20);
  assert.equal(options.payloadSize, 512);
  assert.equal(options.intervalMs, 5);
  assert.equal(options.timeoutMs, 2000);
  assert.equal(options.insecure, true);
  assert.equal(options.json, true);
});

test('parseFabricTransportEchoServerArgs parses foreground server options', () => {
  const options = parseFabricTransportEchoServerArgs([
    '--host',
    '0.0.0.0',
    '--port=8765',
    '--path',
    'echo',
    '--json'
  ]);

  assert.deepEqual(options, {
    host: '0.0.0.0',
    port: 8765,
    path: '/echo',
    tlsKey: '',
    tlsCert: '',
    json: true
  });
});

test('runFabricTransportEcho measures RTT against local echo server', async (t) => {
  const server = await startFabricTransportEchoServer({
    host: '127.0.0.1',
    port: 0,
    path: '/echo'
  }, { WebSocket });
  t.after(() => closeEchoServer(server));

  const result = await runFabricTransportEcho([
    server.url,
    '--count',
    '3',
    '--payload-size',
    '16',
    '--json'
  ], { WebSocket });

  assert.equal(result.ok, true);
  assert.equal(result.target, server.url);
  assert.equal(result.successes, 3);
  assert.equal(result.failures.length, 0);
  assert.equal(result.rttMs.count, 3);
  assert.equal(result.samples.length, 3);
  assert.equal(result.samples.every((sample) => sample.payloadBytes === 16), true);
});

test('summarizeRtt calculates stable p50 and p95 metrics', () => {
  assert.deepEqual(summarizeRtt([
    { rttMs: 10 },
    { rttMs: 30 },
    { rttMs: 20 },
    { rttMs: 100 }
  ]), {
    count: 4,
    min: 10,
    max: 100,
    avg: 40,
    p50: 20,
    p95: 100
  });
});

test('formatFabricTransportEchoReport renders benchmark summary', () => {
  const text = formatFabricTransportEchoReport({
    ok: true,
    generatedAt: '2026-06-26T00:00:00.000Z',
    target: 'ws://127.0.0.1:8765/echo',
    count: 2,
    successes: 2,
    payloadSize: 16,
    rttMs: { min: 1, p50: 2, p95: 3, max: 4, avg: 2.5 }
  });

  assert.match(text, /fabric transport echo/);
  assert.match(text, /target: ws:\/\/127\.0\.0\.1:8765\/echo/);
  assert.match(text, /count: 2\/2 payload=16B/);
  assert.match(text, /p95=3ms/);
  assert.match(text, /result: pass/);
});

test('runFabricCommandRouter routes transport echo JSON', async () => {
  const writes = [];
  const exits = [];

  await runFabricCommandRouter([
    'fabric',
    'transport',
    'echo',
    'ws://127.0.0.1:8765/echo',
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
    runFabricTransportEcho: async (args) => ({
      ok: true,
      json: args.includes('--json'),
      generatedAt: '2026-06-26T00:00:00.000Z',
      command: 'aih fabric transport echo',
      target: 'ws://127.0.0.1:8765/echo',
      count: 1,
      payloadSize: 16,
      durationMs: 1,
      successes: 1,
      failures: [],
      rttMs: { min: 1, p50: 1, p95: 1, max: 1, avg: 1 }
    })
  });

  assert.deepEqual(exits, [0]);
  const payload = JSON.parse(writes.join(''));
  assert.equal(payload.ok, true);
  assert.equal(payload.command, 'aih fabric transport echo');
  assert.equal(payload.rttMs.p95, 1);
});
