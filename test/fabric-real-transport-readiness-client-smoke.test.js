'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildReadinessUrl,
  formatReport,
  parseArgs,
  runTransportReadinessClientSmoke,
  selectReadyProfile
} = require('../scripts/fabric-real-transport-readiness-client-smoke');
const {
  runFabricCommandRouter
} = require('../lib/cli/commands/fabric-router');
const {
  saveControlPlaneProfile
} = require('../lib/server/control-plane-profile-store');

function createAiHome(t) {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-readiness-client-smoke-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  return aiHomeDir;
}

function saveProfile(aiHomeDir, overrides = {}) {
  return saveControlPlaneProfile({
    id: 'cp-aws',
    name: 'AWS Current',
    endpoint: 'http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527',
    connectionMode: 'direct',
    state: 'paired',
    authState: 'paired',
    deviceToken: 'device-token',
    ...overrides
  }, { active: true }, { fs, aiHomeDir }).profile;
}

function createReadinessResult() {
  return {
    generatedAt: '2026-06-28T00:00:00.000Z',
    purpose: 'runtime',
    nodeId: 'aws-current-node',
    summary: {
      nodes: 1,
      defaultTransports: ['relay'],
      defaultTransport: 'relay',
      fallbackReady: true,
      promotionReady: false,
      promotedTransports: [],
      blockers: [
        'webrtc:turn_relay_gate_not_ready',
        'webtransport:webtransport_h3_endpoint_missing'
      ]
    },
    inventory: {},
    nodes: [
      {
        node: { id: 'aws-current-node', name: 'AWS Current Node' },
        purpose: 'runtime',
        defaultTransport: 'relay',
        fallbackReady: true,
        relayFallback: {
          ready: true,
          selectedTransportId: 'aws-current-node-relay',
          measured: true,
          measurementPass: true,
          measurement: {
            status: 'ws_echo_pass',
            sampleCount: 20,
            successRate: 1,
            failures: 0,
            rttMs: { p50: 1, p95: 2, p99: 3 }
          }
        },
        advanced: []
      }
    ]
  };
}

test('transport readiness client smoke parser defaults to AWS current profile path', () => {
  const options = parseArgs(['--json'], {
    HOME: '/Users/example',
    AIH_HOST_HOME: '/Users/example'
  });

  assert.equal(options.endpoint, 'http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527');
  assert.equal(options.aiHomeDir, '/Users/example/.ai_home');
  assert.equal(options.nodeId, 'aws-current-node');
  assert.equal(options.purpose, 'runtime');
  assert.equal(options.json, true);
});

test('transport readiness client smoke selects ready AWS profile and keeps token redacted', async (t) => {
  const aiHomeDir = createAiHome(t);
  saveProfile(aiHomeDir);
  const calls = [];

  const report = await runTransportReadinessClientSmoke({
    aiHomeDir,
    endpoint: 'http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527',
    nodeId: 'aws-current-node',
    timeoutMs: 1000
  }, {
    fetchImpl: async (url, init = {}) => {
      calls.push({
        url: String(url),
        authorization: String(init.headers && init.headers.authorization || '')
      });
      if (!init.headers || !init.headers.authorization) {
        return {
          ok: false,
          status: 401,
          json: async () => ({ ok: false, error: 'unauthorized_control_plane_device' })
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          rpc: 'fabric.transport.readiness',
          result: createReadinessResult()
        })
      };
    }
  });

  assert.equal(report.ok, true);
  assert.equal(report.profile.deviceTokenPresent, true);
  assert.equal(report.summary.defaultTransport, 'relay');
  assert.equal(report.summary.fallbackReady, true);
  assert.equal(report.node.relayMeasurementPass, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].authorization, '');
  assert.equal(calls[1].authorization, 'Bearer device-token');
  assert.equal(calls[0].url, buildReadinessUrl('http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527', {
    nodeId: 'aws-current-node',
    purpose: 'runtime'
  }));
  assert.equal(JSON.stringify(report).includes('device-token'), false);
  assert.match(formatReport(report), /^AIH Fabric transport readiness/);
  assert.doesNotMatch(formatReport(report), /client smoke/);
  assert.match(formatReport(report), /result: pass/);
});

test('transport readiness client smoke rejects missing ready profile', () => {
  assert.throws(() => selectReadyProfile({
    activeProfileId: '',
    profiles: [
      {
        id: 'cp-aws',
        endpoint: 'http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527',
        state: 'discovered',
        authState: 'unpaired',
        deviceToken: ''
      }
    ]
  }, {
    endpoint: 'http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527'
  }), /No ready server profile/);
});

test('transport readiness client smoke fails when unauthenticated endpoint is not protected', async (t) => {
  const aiHomeDir = createAiHome(t);
  saveProfile(aiHomeDir);

  const report = await runTransportReadinessClientSmoke({
    aiHomeDir,
    endpoint: 'http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527',
    nodeId: 'aws-current-node',
    timeoutMs: 1000
  }, {
    fetchImpl: async (_url, init = {}) => ({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        rpc: init.headers && init.headers.authorization ? 'fabric.transport.readiness' : 'unexpected.public',
        result: createReadinessResult()
      })
    })
  });

  assert.equal(report.ok, false);
  assert.equal(report.checks.unauthRejected, false);
  assert.equal(report.blockers.includes('unauthRejected'), true);
  assert.match(formatReport(report), /readiness_blockers:/);
  assert.doesNotMatch(formatReport(report), /smoke_blockers:/);
});

test('fabric command router routes transport readiness JSON', async () => {
  const writes = [];
  const exits = [];

  await runFabricCommandRouter([
    'fabric',
    'transport',
    'readiness',
    '--endpoint',
    'http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527',
    '--node-id',
    'aws-current-node',
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
    runFabricTransportReadinessClientCommand: async (args) => {
      assert.equal(args.includes('--json'), true);
      return {
        ok: true,
        json: true,
        profile: {
          id: 'cp-aws',
          endpoint: 'http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527',
          deviceTokenPresent: true
        },
        target: { nodeId: 'aws-current-node' },
        http: { unauthenticatedStatus: 401, authorizedStatus: 200 },
        checks: { unauthRejected: true, authorizedRead: true },
        summary: {
          nodes: 1,
          defaultTransport: 'relay',
          fallbackReady: true,
          promotionReady: false,
          blockers: []
        },
        node: {
          nodeId: 'aws-current-node',
          relayMeasurementPass: true
        },
        blockers: []
      };
    }
  });

  assert.deepEqual(exits, [0]);
  const payload = JSON.parse(writes.join(''));
  assert.equal(payload.ok, true);
  assert.equal(payload.summary.defaultTransport, 'relay');
  assert.equal(payload.profile.deviceTokenPresent, true);
  assert.equal(JSON.stringify(payload).includes('device-token'), false);
});
