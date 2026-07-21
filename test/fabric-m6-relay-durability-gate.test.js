'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const WebSocket = require('ws');

const {
  closeEchoServer,
  startFabricTransportEchoServer
} = require('../lib/cli/services/fabric/transport-echo');
const {
  buildSummary,
  buildWebSocketUrlFromEndpoint,
  formatReport,
  parseArgs,
  runDurabilityGate,
  summarizeFailureReasons,
  summarizeRttValues
} = require('../scripts/fabric-m6-relay-durability-gate');

test('M6 relay durability gate parser defaults to AWS current default port', () => {
  const options = parseArgs(['--json']);

  assert.equal(options.endpoint, 'http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527');
  assert.equal(options.path, '/v0/fabric/transport/echo');
  assert.equal(options.rounds, 6);
  assert.equal(options.countPerRound, 20);
  assert.equal(options.payloadSize, 64);
  assert.equal(options.timeoutMs, 10000);
  assert.equal(options.roundIntervalMs, 1000);
  assert.equal(options.echoIntervalMs, 0);
  assert.equal(options.minSuccessRate, 1);
  assert.equal(options.json, true);
});

test('M6 relay durability gate accepts direct target and percent budget', () => {
  const options = parseArgs([
    '--target',
    'wss://control.example.com:9527/v0/fabric/transport/echo',
    '--rounds=3',
    '--count-per-round',
    '4',
    '--payload-size',
    '16',
    '--timeout-ms',
    '2000',
    '--round-interval-ms=10',
    '--echo-interval-ms=2',
    '--min-success-rate',
    '99%'
  ]);

  assert.equal(options.target, 'wss://control.example.com:9527/v0/fabric/transport/echo');
  assert.equal(options.rounds, 3);
  assert.equal(options.countPerRound, 4);
  assert.equal(options.payloadSize, 16);
  assert.equal(options.timeoutMs, 2000);
  assert.equal(options.roundIntervalMs, 10);
  assert.equal(options.echoIntervalMs, 2);
  assert.equal(options.minSuccessRate, 0.99);
});

test('M6 relay durability gate builds websocket URL from endpoint without new ports', () => {
  assert.equal(
    buildWebSocketUrlFromEndpoint(
      'http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527',
      'v0/fabric/transport/echo'
    ),
    'ws://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527/v0/fabric/transport/echo'
  );
  assert.equal(
    buildWebSocketUrlFromEndpoint('https://control.example.com:9527/base', '/echo'),
    'wss://control.example.com:9527/echo'
  );
});

test('M6 relay durability gate summarizes RTT p99 and failures', () => {
  assert.deepEqual(summarizeRttValues([30, 10, 20, 100, 40]), {
    count: 5,
    min: 10,
    max: 100,
    avg: 40,
    p50: 30,
    p95: 100,
    p99: 100
  });

  assert.deepEqual(summarizeFailureReasons([
    { ok: false, failures: [{ error: 'echo_response_timeout' }, { error: 'echo_response_timeout' }] },
    { ok: false, failures: [{ error: 'echo_socket_closed' }] },
    { ok: false, failures: [] }
  ]), [
    { reason: 'echo_response_timeout', count: 2 },
    { reason: 'echo_socket_closed', count: 1 },
    { reason: 'round_incomplete', count: 1 }
  ]);
});

test('M6 relay durability gate summary blocks incomplete rounds', () => {
  const summary = buildSummary([
    {
      ok: true,
      count: 2,
      successes: 2,
      rttMs: { count: 2 },
      samples: [{ rttMs: 10 }, { rttMs: 20 }],
      failures: []
    },
    {
      ok: false,
      count: 2,
      successes: 1,
      rttMs: { count: 1 },
      samples: [{ rttMs: 30 }],
      failures: [{ error: 'echo_response_timeout' }]
    }
  ], { minSuccessRate: 1 });

  assert.equal(summary.ok, false);
  assert.equal(summary.totalAttempts, 4);
  assert.equal(summary.successes, 3);
  assert.equal(summary.successRate, 0.75);
  assert.equal(summary.failedRounds, 1);
  assert.equal(summary.blockers.includes('relay_rounds_failed'), true);
  assert.equal(summary.blockers.includes('relay_echo_failures'), true);
  assert.equal(summary.blockers.includes('relay_success_rate_below_budget'), true);
  assert.equal(summary.rttMs.p95, 30);
});

test('runDurabilityGate measures real loopback websocket echo across rounds', async (t) => {
  const server = await startFabricTransportEchoServer({
    host: '127.0.0.1',
    port: 0,
    path: '/echo'
  }, { WebSocket });
  t.after(() => closeEchoServer(server));

  const report = await runDurabilityGate({
    target: server.url,
    rounds: 2,
    countPerRound: 3,
    payloadSize: 16,
    timeoutMs: 2000,
    roundIntervalMs: 1,
    echoIntervalMs: 0
  }, { WebSocket });

  assert.equal(report.ok, true);
  assert.equal(report.target.echoUrl, server.url);
  assert.equal(report.summary.rounds, 2);
  assert.equal(report.summary.totalAttempts, 6);
  assert.equal(report.summary.successes, 6);
  assert.equal(report.summary.rttMs.count, 6);
  assert.equal(report.rounds.every((round) => round.ok), true);
  assert.match(formatReport(report), /result: pass/);
});
