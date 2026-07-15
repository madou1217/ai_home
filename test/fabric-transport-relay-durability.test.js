'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  runFabricCommandRouter
} = require('../lib/cli/commands/fabric-router');
const {
  formatFabricTransportRelayDurabilityReport,
  runFabricTransportRelayDurabilityCommand
} = require('../lib/cli/services/fabric/transport-relay-durability');

function createDurabilityReport(overrides = {}) {
  return {
    ok: true,
    target: {
      endpoint: 'http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527',
      echoUrl: 'ws://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527/v0/fabric/transport/echo'
    },
    summary: {
      ok: true,
      rounds: 2,
      passedRounds: 2,
      failedRounds: 0,
      totalAttempts: 4,
      successes: 4,
      failures: 0,
      successRate: 1,
      rttMs: { count: 4, min: 100, p50: 101, p95: 102, p99: 102, max: 102, avg: 101 }
    },
    rounds: [],
    ...overrides
  };
}

test('transport relay-durability command runs durability gate options', async () => {
  const report = await runFabricTransportRelayDurabilityCommand([
    '--endpoint',
    'http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527',
    '--rounds',
    '2',
    '--count-per-round',
    '4',
    '--json'
  ], {
    runDurabilityGate: async (options) => {
      assert.equal(options.endpoint, 'http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527');
      assert.equal(options.rounds, 2);
      assert.equal(options.countPerRound, 4);
      assert.equal(options.json, true);
      return createDurabilityReport();
    }
  });

  assert.equal(report.ok, true);
  assert.equal(report.exitOk, true);
  assert.equal(report.json, true);
  assert.match(formatFabricTransportRelayDurabilityReport(report), /^AIH Fabric M6 relay durability gate/);
});

test('transport relay-durability command exits false when durability gate fails', async () => {
  const report = await runFabricTransportRelayDurabilityCommand([
    '--rounds',
    '1'
  ], {
    runDurabilityGate: async () => createDurabilityReport({
      ok: false,
      summary: {
        ok: false,
        rounds: 1,
        passedRounds: 0,
        failedRounds: 1,
        totalAttempts: 2,
        successes: 1,
        failures: 1,
        successRate: 0.5,
        rttMs: { count: 1, min: 100, p50: 100, p95: 100, p99: 100, max: 100, avg: 100 },
        blockers: ['relay_echo_failures']
      }
    })
  });

  assert.equal(report.ok, false);
  assert.equal(report.exitOk, false);
  assert.equal(report.summary.blockers.includes('relay_echo_failures'), true);
});

test('fabric command router routes transport relay-durability JSON', async () => {
  const writes = [];
  const exits = [];

  await runFabricCommandRouter([
    'fabric',
    'transport',
    'relay-durability',
    '--endpoint',
    'http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527',
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
    runFabricTransportRelayDurabilityCommand: async (args) => {
      assert.equal(args.includes('--json'), true);
      return {
        ...createDurabilityReport(),
        json: true,
        exitOk: true
      };
    }
  });

  assert.deepEqual(exits, [0]);
  const payload = JSON.parse(writes.join(''));
  assert.equal(payload.ok, true);
  assert.equal(payload.summary.successRate, 1);
});

test('fabric command router exits non-zero on relay-durability failure', async () => {
  const writes = [];
  const exits = [];

  await runFabricCommandRouter([
    'fabric',
    'transport',
    'relay-durability',
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
    runFabricTransportRelayDurabilityCommand: async () => ({
      ...createDurabilityReport({ ok: false }),
      json: true,
      exitOk: false
    })
  });

  assert.deepEqual(exits, [1]);
  assert.equal(JSON.parse(writes.join('')).ok, false);
});
