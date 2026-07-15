'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  runFabricCommandRouter
} = require('../lib/cli/commands/fabric-router');
const {
  formatFabricTransportCloudEdgeReport,
  runFabricTransportCloudEdgeCommand
} = require('../lib/cli/services/fabric/transport-cloud-edge');

function createCloudEdgeReport(overrides = {}) {
  return {
    ok: true,
    mode: 'fabric-cloud-edge-preflight',
    target: {
      endpoint: 'http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527',
      ssh: 'ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com',
      remoteDir: '/home/ubuntu/aih-fabric-current',
      port: 9527
    },
    summary: {
      cloudEdgeReady: false,
      udpReachable: false,
      packetArrivalCaptured: false,
      hostFirewallBlocksUdp: false,
      cloudApiCredentialsReady: false,
      interface: 'enp39s0',
      privateAddress: '172.31.47.163',
      publicIpv4: '43.207.102.163',
      securityGroupIds: ['sg-01e33f3412fabfded'],
      blockers: ['turn_default_udp_9527_unreachable', 'aws_public_udp_path_blocked', 'aws_iam_role_missing'],
      nextActions: ['Verify AWS Security Group inbound UDP 9527.']
    },
    ...overrides
  };
}

test('transport cloud-edge command keeps diagnostic success separate from blocked edge state', async () => {
  const report = await runFabricTransportCloudEdgeCommand([
    '--endpoint',
    'http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527'
  ], {
    runCloudEdgePreflight: async (options) => {
      assert.equal(options.endpoint, 'http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527');
      assert.equal(options.failOnBlocked, false);
      return createCloudEdgeReport();
    }
  });

  assert.equal(report.ok, true);
  assert.equal(report.exitOk, true);
  assert.equal(report.summary.cloudEdgeReady, false);
  assert.match(formatFabricTransportCloudEdgeReport(report), /^AIH Fabric cloud edge preflight/);
});

test('transport cloud-edge command honors fail-on-blocked', async () => {
  const report = await runFabricTransportCloudEdgeCommand([
    '--fail-on-blocked'
  ], {
    runCloudEdgePreflight: async (options) => {
      assert.equal(options.failOnBlocked, true);
      return createCloudEdgeReport();
    }
  });

  assert.equal(report.ok, true);
  assert.equal(report.exitOk, false);
  assert.equal(report.summary.blockers.includes('aws_public_udp_path_blocked'), true);
});

test('fabric command router routes transport cloud-edge JSON', async () => {
  const writes = [];
  const exits = [];

  await runFabricCommandRouter([
    'fabric',
    'transport',
    'cloud-edge',
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
    runFabricTransportCloudEdgeCommand: async (args) => {
      assert.equal(args.includes('--json'), true);
      return {
        ...createCloudEdgeReport(),
        json: true,
        exitOk: true
      };
    }
  });

  assert.deepEqual(exits, [0]);
  const payload = JSON.parse(writes.join(''));
  assert.equal(payload.ok, true);
  assert.equal(payload.json, true);
  assert.equal(payload.summary.publicIpv4, '43.207.102.163');
});
