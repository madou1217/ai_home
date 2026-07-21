'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  runFabricCommandRouter
} = require('../lib/cli/commands/fabric-router');
const {
  buildCloudEdgeArgs,
  buildPromotionGateArgs,
  buildReadinessArgs,
  buildSummary,
  formatFabricTransportStatusReport,
  parseArgs,
  runFabricTransportStatusCommand
} = require('../lib/cli/services/fabric/transport-status');

function createReadinessReport(overrides = {}) {
  return {
    ok: true,
    summary: {
      defaultTransport: 'relay',
      fallbackReady: true,
      promotionReady: false,
      promotedTransports: [],
      blockers: ['turn_relay_gate_not_ready']
    },
    node: {
      nodeId: 'aws-current-node',
      relayMeasurementPass: true
    },
    blockers: [],
    ...overrides
  };
}

function createCloudEdgeReport(overrides = {}) {
  return {
    ok: true,
    summary: {
      cloudEdgeReady: false,
      udpReachable: false,
      packetArrivalCaptured: false,
      hostFirewallBlocksUdp: false,
      cloudApiCredentialsReady: false,
      publicIpv4: '43.207.102.163',
      securityGroupIds: ['sg-01e33f3412fabfded'],
      blockers: ['turn_default_udp_9527_unreachable', 'aws_public_udp_path_blocked'],
      nextActions: ['Verify AWS Security Group inbound UDP 9527.']
    },
    ...overrides
  };
}

test('transport status parser defaults to current AWS target', () => {
  const options = parseArgs(['--json']);

  assert.equal(options.endpoint, 'http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527');
  assert.equal(options.nodeId, 'aws-current-node');
  assert.equal(options.sshTarget, 'ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com');
  assert.equal(options.remoteDir, '/home/ubuntu/aih-fabric-current');
  assert.equal(options.port, 9527);
  assert.equal(options.json, true);
});

test('transport status builds focused child command args', () => {
  const options = parseArgs([
    '--endpoint',
    'http://control.example.com:9527',
    '--node-id',
    'office-node',
    '--ssh',
    'ubuntu@example.com',
    '--ssh-key',
    '/tmp/key.pem',
    '--port',
    '9527',
    '--allow-direct-webrtc-promotion',
    '--direct-webrtc-max-p95-ms',
    '900'
  ]);

  assert.deepEqual(buildReadinessArgs(options), [
    '--endpoint',
    'http://control.example.com:9527',
    '--node-id',
    'office-node',
    '--timeout-ms',
    '10000'
  ]);
  assert.deepEqual(buildCloudEdgeArgs(options), [
    '--endpoint',
    'http://control.example.com:9527',
    '--ssh',
    'ubuntu@example.com',
    '--ssh-key',
    '/tmp/key.pem',
    '--remote-dir',
    '/home/ubuntu/aih-fabric-current',
    '--port',
    '9527',
    '--udp-timeout-ms',
    '5000'
  ]);
  assert.deepEqual(buildPromotionGateArgs(options), [
    '--endpoint',
    'http://control.example.com:9527',
    '--ssh',
    'ubuntu@example.com',
    '--ssh-key',
    '/tmp/key.pem',
    '--remote-dir',
    '/home/ubuntu/aih-fabric-current',
    '--port',
    '9527',
    '--allow-direct-webrtc-promotion',
    '--direct-webrtc-max-p95-ms',
    '900'
  ]);
});

test('transport status summary distinguishes usable relay from unfinished promotion', () => {
  const summary = buildSummary({
    readiness: { ok: true, report: createReadinessReport() },
    cloudEdge: { ok: true, report: createCloudEdgeReport() },
    promotionGate: { skipped: true, ok: true, report: null }
  });

  assert.equal(summary.status, 'usable_partial');
  assert.equal(summary.remoteDevelopmentReady, true);
  assert.equal(summary.fallbackReady, true);
  assert.equal(summary.advancedPromotionReady, false);
  assert.equal(summary.cloudEdgeReady, false);
  assert.equal(summary.blockers.includes('aws_public_udp_path_blocked'), true);
  assert.equal(summary.blockerDetails.some((item) => item.domain === 'cloud_edge'), true);
  assert.equal(summary.blockerDetails.some((item) => item.domain === 'transport_promotion'), true);
  assert.equal(summary.nextActions.some((item) => item.includes('relay as the default')), true);
});

test('transport status command aggregates injected readiness and cloud-edge reports', async () => {
  const report = await runFabricTransportStatusCommand([
    '--endpoint',
    'http://control.example.com:9527',
    '--json'
  ], {
    runFabricTransportReadinessClientCommand: async (args) => {
      assert.equal(args.includes('--endpoint'), true);
      return createReadinessReport();
    },
    runFabricTransportCloudEdgeCommand: async (args) => {
      assert.equal(args.includes('--ssh'), true);
      return createCloudEdgeReport();
    }
  });

  assert.equal(report.ok, true);
  assert.equal(report.json, true);
  assert.equal(report.exitOk, true);
  assert.equal(report.summary.status, 'usable_partial');
  const formatted = formatFabricTransportStatusReport(report);
  assert.match(formatted, /^AIH Fabric transport status/);
  assert.match(formatted, /blocker_details:/);
});

test('transport status summary uses promotion gate promoted transports when present', async () => {
  const report = await runFabricTransportStatusCommand([
    '--with-promotion-gate',
    '--allow-direct-webrtc-promotion'
  ], {
    runFabricTransportReadinessClientCommand: async () => createReadinessReport(),
    runFabricTransportCloudEdgeCommand: async () => createCloudEdgeReport(),
    runFabricTransportPromotionGateCommand: async (args) => {
      assert.equal(args.includes('--allow-direct-webrtc-promotion'), true);
      return {
        ok: true,
        summary: {
          promotionReady: true,
          promotedTransports: ['webrtc'],
          defaultTransport: 'webrtc',
          fallbackReady: true,
          blockers: []
        }
      };
    }
  });

  assert.equal(report.summary.advancedPromotionReady, true);
  assert.equal(report.summary.defaultTransport, 'webrtc');
  assert.deepEqual(report.summary.promotedTransports, ['webrtc']);
  assert.deepEqual(report.summary.blockers, []);
  assert.deepEqual(report.summary.nextActions, []);
  assert.equal(report.exitOk, true);
});

test('transport status command can fail CI-style when promotion is still blocked', async () => {
  const report = await runFabricTransportStatusCommand(['--fail-on-blocked'], {
    runFabricTransportReadinessClientCommand: async () => createReadinessReport(),
    runFabricTransportCloudEdgeCommand: async () => createCloudEdgeReport()
  });

  assert.equal(report.ok, true);
  assert.equal(report.exitOk, false);
  assert.equal(report.summary.advancedPromotionReady, false);
});

test('fabric command router routes transport status JSON', async () => {
  const writes = [];
  const exits = [];

  await runFabricCommandRouter([
    'fabric',
    'transport',
    'status',
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
    runFabricTransportStatusCommand: async (args) => {
      assert.equal(args.includes('--json'), true);
      return {
        ok: true,
        json: true,
        exitOk: true,
        summary: { status: 'usable_partial' }
      };
    }
  });

  assert.deepEqual(exits, [0]);
  const payload = JSON.parse(writes.join(''));
  assert.equal(payload.summary.status, 'usable_partial');
});
