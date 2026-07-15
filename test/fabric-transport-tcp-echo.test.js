const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');

const {
  closeTcpEchoServer,
  formatFabricTransportTcpEchoReport,
  parseFabricTransportTcpEchoArgs,
  parseFabricTransportTcpEchoServerArgs,
  runFabricTransportTcpEcho,
  startFabricTransportTcpEchoServer
} = require('../lib/cli/services/fabric/transport-tcp-echo');
const { runFabricCommandRouter } = require('../lib/cli/commands/fabric-router');

test('parseFabricTransportTcpEchoArgs parses tcp benchmark options', () => {
  const options = parseFabricTransportTcpEchoArgs([
    'tcp://127.0.0.1:8766',
    '--count',
    '20',
    '--payload-size=512',
    '--interval-ms',
    '5',
    '--timeout-ms',
    '2000',
    '--json'
  ]);

  assert.equal(options.target.href, 'tcp://127.0.0.1:8766');
  assert.equal(options.target.host, '127.0.0.1');
  assert.equal(options.target.port, 8766);
  assert.equal(options.count, 20);
  assert.equal(options.payloadSize, 512);
  assert.equal(options.intervalMs, 5);
  assert.equal(options.timeoutMs, 2000);
  assert.equal(options.json, true);
});

test('parseFabricTransportTcpEchoServerArgs parses foreground server options', () => {
  const options = parseFabricTransportTcpEchoServerArgs([
    '--host',
    '0.0.0.0',
    '--port=8766',
    '--json'
  ]);

  assert.deepEqual(options, {
    host: '0.0.0.0',
    port: 8766,
    json: true
  });
});

test('runFabricTransportTcpEcho measures RTT against local tcp echo server', async (t) => {
  const server = await startFabricTransportTcpEchoServer({
    host: '127.0.0.1',
    port: 0
  });
  t.after(() => closeTcpEchoServer(server));

  const result = await runFabricTransportTcpEcho([
    server.url,
    '--count',
    '3',
    '--payload-size',
    '16',
    '--json'
  ]);

  assert.equal(result.ok, true);
  assert.equal(result.target, server.url);
  assert.equal(result.successes, 3);
  assert.equal(result.failures.length, 0);
  assert.equal(result.rttMs.count, 3);
  assert.equal(result.samples.length, 3);
  assert.equal(result.samples.every((sample) => sample.payloadBytes > 16), true);
});

test('tcp echo server tolerates client socket reset', async (t) => {
  const server = await startFabricTransportTcpEchoServer({
    host: '127.0.0.1',
    port: 0
  });
  t.after(() => closeTcpEchoServer(server));

  await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: server.host, port: server.port });
    socket.on('error', () => {});
    socket.once('connect', () => {
      socket.destroy(new Error('client_reset'));
      setTimeout(resolve, 10);
    });
    socket.once('timeout', () => reject(new Error('connect_timeout')));
    socket.setTimeout(1000);
  });

  const result = await runFabricTransportTcpEcho([
    server.url,
    '--count',
    '1',
    '--payload-size',
    '8',
    '--json'
  ]);

  assert.equal(result.ok, true);
  assert.equal(result.successes, 1);
});

test('formatFabricTransportTcpEchoReport renders benchmark summary', () => {
  const text = formatFabricTransportTcpEchoReport({
    ok: true,
    generatedAt: '2026-06-26T00:00:00.000Z',
    target: 'tcp://127.0.0.1:8766',
    count: 2,
    successes: 2,
    payloadSize: 16,
    rttMs: { min: 1, p50: 2, p95: 3, max: 4, avg: 2.5 }
  });

  assert.match(text, /fabric transport tcp-echo/);
  assert.match(text, /target: tcp:\/\/127\.0\.0\.1:8766/);
  assert.match(text, /count: 2\/2 payload=16B/);
  assert.match(text, /p95=3ms/);
  assert.match(text, /result: pass/);
});

test('runFabricCommandRouter routes transport tcp-echo JSON', async () => {
  const writes = [];
  const exits = [];

  await runFabricCommandRouter([
    'fabric',
    'transport',
    'tcp-echo',
    'tcp://127.0.0.1:8766',
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
    runFabricTransportTcpEcho: async (args) => ({
      ok: true,
      json: args.includes('--json'),
      generatedAt: '2026-06-26T00:00:00.000Z',
      command: 'aih fabric transport tcp-echo',
      target: 'tcp://127.0.0.1:8766',
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
  assert.equal(payload.command, 'aih fabric transport tcp-echo');
  assert.equal(payload.rttMs.p95, 1);
});
