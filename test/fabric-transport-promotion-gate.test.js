'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  runFabricCommandRouter
} = require('../lib/cli/commands/fabric-router');
const {
  formatFabricTransportPromotionGateReport,
  runFabricTransportPromotionGateCommand
} = require('../lib/cli/services/fabric/transport-promotion-gate');

function createPromotionReport(overrides = {}) {
  return {
    ok: true,
    target: {
      endpoint: 'http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527'
    },
    gates: {
      relay: { candidateReady: true, promotionReady: true, blockers: [] },
      webrtc: { candidateReady: true, promotionReady: false, blockers: ['turn_relay_gate_not_ready'] },
      turn: { candidateReady: false, promotionReady: false, blockers: ['turn_ice_server_not_configured'] }
    },
    summary: {
      promotionReady: false,
      defaultTransport: 'relay',
      promotedTransports: [],
      blockers: ['webrtc:turn_relay_gate_not_ready', 'turn:turn_ice_server_not_configured']
    },
    ...overrides
  };
}

test('transport promotion-gate command keeps gate success separate from promotion failure', async () => {
  const report = await runFabricTransportPromotionGateCommand([
    '--endpoint',
    'http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527'
  ], {
    runPromotionGate: async (options) => {
      assert.equal(options.endpoint, 'http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527');
      assert.equal(options.failOnBlocked, false);
      return createPromotionReport();
    }
  });

  assert.equal(report.ok, true);
  assert.equal(report.exitOk, true);
  assert.equal(report.summary.promotionReady, false);
  assert.match(formatFabricTransportPromotionGateReport(report), /^AIH Fabric M6 transport promotion gate/);
});

test('transport promotion-gate command honors fail-on-blocked without rewriting report ok', async () => {
  const report = await runFabricTransportPromotionGateCommand([
    '--fail-on-blocked'
  ], {
    runPromotionGate: async (options) => {
      assert.equal(options.failOnBlocked, true);
      return createPromotionReport();
    }
  });

  assert.equal(report.ok, true);
  assert.equal(report.exitOk, false);
  assert.equal(report.summary.promotionReady, false);
});

test('transport promotion-gate command treats publish failure as failed exit even when gate promoted', async () => {
  const report = await runFabricTransportPromotionGateCommand([
    '--fail-on-blocked',
    '--publish-promotion'
  ], {
    runPromotionGate: async () => createPromotionReport({
      ok: false,
      summary: {
        promotionReady: true,
        defaultTransport: 'webrtc',
        promotedTransports: ['webrtc'],
        blockers: [],
        promotionPublished: false
      },
      publishPromotion: {
        requested: true,
        ok: false,
        reason: 'publish_failed'
      }
    })
  });

  assert.equal(report.summary.promotionReady, true);
  assert.equal(report.exitOk, false);
});

test('fabric command router routes transport promotion-gate JSON', async () => {
  const writes = [];
  const exits = [];

  await runFabricCommandRouter([
    'fabric',
    'transport',
    'promotion-gate',
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
    runFabricTransportPromotionGateCommand: async (args) => {
      assert.equal(args.includes('--json'), true);
      return {
        ...createPromotionReport(),
        json: true,
        exitOk: true
      };
    }
  });

  assert.deepEqual(exits, [0]);
  const payload = JSON.parse(writes.join(''));
  assert.equal(payload.ok, true);
  assert.equal(payload.json, true);
  assert.equal(payload.summary.defaultTransport, 'relay');
  assert.deepEqual(payload.summary.promotedTransports, []);
});
