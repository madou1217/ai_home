'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  runFabricCommandRouter
} = require('../lib/cli/commands/fabric-router');
const {
  formatFabricTransportPrerequisitesReport,
  runFabricTransportPrerequisitesCommand
} = require('../lib/cli/services/fabric/transport-prerequisites');

function createAuditReport(overrides = {}) {
  return {
    ok: true,
    mode: 'fabric-m6-prerequisite-audit',
    target: {
      endpoint: 'http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527'
    },
    gates: {
      aws: { candidateReady: true, promotionReady: true, blockers: [] },
      turn: { candidateReady: false, promotionReady: false, blockers: ['turn_ice_server_not_configured'] }
    },
    summary: {
      baseReady: true,
      promotionReady: false,
      readyTransports: [],
      blockers: ['turn:turn_ice_server_not_configured']
    },
    ...overrides
  };
}

test('transport prerequisites command keeps audit success separate from promotion failure', async () => {
  const report = await runFabricTransportPrerequisitesCommand([
    '--endpoint',
    'http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527'
  ], {
    runPrerequisiteAudit: async (options) => {
      assert.equal(options.endpoint, 'http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527');
      assert.equal(options.failOnBlocked, false);
      return createAuditReport();
    }
  });

  assert.equal(report.ok, true);
  assert.equal(report.exitOk, true);
  assert.equal(report.summary.promotionReady, false);
  assert.match(formatFabricTransportPrerequisitesReport(report), /^AIH Fabric M6 prerequisite audit/);
});

test('transport prerequisites command honors fail-on-blocked without rewriting report ok', async () => {
  const report = await runFabricTransportPrerequisitesCommand([
    '--fail-on-blocked'
  ], {
    runPrerequisiteAudit: async (options) => {
      assert.equal(options.failOnBlocked, true);
      return createAuditReport();
    }
  });

  assert.equal(report.ok, true);
  assert.equal(report.exitOk, false);
  assert.equal(report.summary.promotionReady, false);
});

test('fabric command router routes transport prerequisites JSON', async () => {
  const writes = [];
  const exits = [];

  await runFabricCommandRouter([
    'fabric',
    'transport',
    'prerequisites',
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
    runFabricTransportPrerequisitesCommand: async (args) => {
      assert.equal(args.includes('--json'), true);
      return {
        ...createAuditReport(),
        json: true,
        exitOk: true
      };
    }
  });

  assert.deepEqual(exits, [0]);
  const payload = JSON.parse(writes.join(''));
  assert.equal(payload.ok, true);
  assert.equal(payload.json, true);
  assert.equal(payload.summary.promotionReady, false);
  assert.deepEqual(payload.summary.blockers, ['turn:turn_ice_server_not_configured']);
});
