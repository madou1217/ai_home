'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  runFabricCommandRouter
} = require('../lib/cli/commands/fabric-router');
const {
  buildTurnConfiguration,
  formatFabricTransportTurnRelayReport,
  parseTurnRelayCommandArgs,
  runFabricTransportTurnRelayCommand
} = require('../lib/cli/services/fabric/transport-turn-relay');

function createTurnProbeReport(overrides = {}) {
  return {
    ok: true,
    mode: 'webrtc-datachannel-smoke',
    endpoint: 'http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527',
    browser: {
      engine: 'chromium',
      channel: 'bundled',
      headed: false
    },
    iceServers: ['turn:turn.example.com:3478'],
    iceTransportPolicy: 'relay',
    rtt: { count: 2, p95: 120 },
    offerer: {
      localCandidateKinds: { relay: 1 },
      remoteCandidateKinds: { relay: 1 }
    },
    answerer: {
      localCandidateKinds: { relay: 1 },
      remoteCandidateKinds: { relay: 1 }
    },
    ...overrides
  };
}

test('turn-relay parser defaults to AWS current and no TURN config', () => {
  const options = parseTurnRelayCommandArgs([]);

  assert.equal(options.endpoint, 'http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527');
  assert.equal(options.pageUrl, 'http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527/ui/');
  assert.equal(options.browserChannel, 'auto');
  assert.deepEqual(options.turnIceServers, []);
  assert.deepEqual(buildTurnConfiguration(options).blockers, ['turn_ice_server_not_configured']);
});

test('turn-relay parser supports TURN aliases and env defaults', () => {
  const options = parseTurnRelayCommandArgs([
    '--endpoint',
    'http://127.0.0.1:9527/',
    '--ice-server',
    'turn:turn.example.com:3478',
    '--ice-username',
    'user',
    '--ice-credential',
    'secret',
    '--sample-count',
    '2',
    '--rpc-sample-count',
    '1',
    '--json'
  ], {
    AIH_TURN_ICE_SERVER: 'turn:env.example.com:3478',
    AIH_TURN_USERNAME: 'env-user',
    AIH_TURN_CREDENTIAL: 'env-secret'
  });

  assert.equal(options.endpoint, 'http://127.0.0.1:9527');
  assert.deepEqual(options.turnIceServers, ['turn:env.example.com:3478', 'turn:turn.example.com:3478']);
  assert.equal(options.turnUsername, 'user');
  assert.equal(options.turnCredential, 'secret');
  assert.equal(options.sampleCount, 2);
  assert.equal(options.rpcSampleCount, 1);
  assert.equal(options.json, true);
  assert.equal(buildTurnConfiguration(options).configured, true);
});

test('turn-relay command reports missing config without running WebRTC smoke', async () => {
  let ranSmoke = false;
  const report = await runFabricTransportTurnRelayCommand([
    '--endpoint',
    'http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527'
  ], {
    env: {},
    runWebrtcDatachannelSmoke: async () => {
      ranSmoke = true;
      return createTurnProbeReport();
    }
  });

  assert.equal(ranSmoke, false);
  assert.equal(report.ok, true);
  assert.equal(report.exitOk, true);
  assert.equal(report.summary.promotionReady, false);
  assert.deepEqual(report.summary.blockers, ['turn_ice_server_not_configured']);
  assert.match(formatFabricTransportTurnRelayReport(report), /^AIH Fabric TURN relay diagnostics/);
});

test('turn-relay command runs relay-only WebRTC when TURN config is complete', async () => {
  const report = await runFabricTransportTurnRelayCommand([
    '--turn-ice-server',
    'turn:turn.example.com:3478',
    '--turn-username',
    'user',
    '--turn-credential',
    'secret'
  ], {
    env: {},
    runWebrtcDatachannelSmoke: async (options) => {
      assert.equal(options.iceTransportPolicy, 'relay');
      assert.equal(options.useDefaultStun, false);
      assert.deepEqual(options.iceServerUrls, ['turn:turn.example.com:3478']);
      assert.equal(options.iceUsername, 'user');
      assert.equal(options.iceCredential, 'secret');
      return createTurnProbeReport();
    }
  });

  assert.equal(report.ok, true);
  assert.equal(report.summary.promotionReady, true);
  assert.deepEqual(report.summary.blockers, []);
  assert.equal(JSON.stringify(report).includes('secret'), false);
});

test('turn-relay command honors fail-on-blocked for missing config', async () => {
  const report = await runFabricTransportTurnRelayCommand([
    '--fail-on-blocked'
  ], {
    env: {}
  });

  assert.equal(report.ok, true);
  assert.equal(report.exitOk, false);
  assert.deepEqual(report.summary.blockers, ['turn_ice_server_not_configured']);
});

test('fabric command router routes transport turn-relay JSON', async () => {
  const writes = [];
  const exits = [];

  await runFabricCommandRouter([
    'fabric',
    'transport',
    'turn-relay',
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
    runFabricTransportTurnRelayCommand: async (args) => {
      assert.equal(args.includes('--json'), true);
      return {
        ok: true,
        mode: 'fabric-turn-relay-diagnostics',
        summary: {
          candidateReady: false,
          promotionReady: false,
          blockers: ['turn_ice_server_not_configured']
        },
        json: true,
        exitOk: true
      };
    }
  });

  assert.deepEqual(exits, [0]);
  const payload = JSON.parse(writes.join(''));
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.summary.blockers, ['turn_ice_server_not_configured']);
});

test('fabric command router exits non-zero for turn-relay fail-on-blocked', async () => {
  const writes = [];
  const exits = [];

  await runFabricCommandRouter([
    'fabric',
    'transport',
    'turn-relay',
    '--fail-on-blocked',
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
    runFabricTransportTurnRelayCommand: async () => ({
      ok: true,
      mode: 'fabric-turn-relay-diagnostics',
      summary: {
        candidateReady: false,
        promotionReady: false,
        blockers: ['turn_ice_server_not_configured']
      },
      json: true,
      exitOk: false
    })
  });

  assert.deepEqual(exits, [1]);
  assert.equal(JSON.parse(writes.join('')).summary.promotionReady, false);
});
