'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const {
  brokerProxyBase,
  parseArgs,
  readManagementKey,
  runBrokerDiagnosticsSmoke
} = require('../scripts/fabric-real-broker-diagnostics-smoke');

function createJsonResponse(status, payload) {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(payload)
  };
}

test('broker diagnostics parser defaults to existing 9527 endpoint', () => {
  const options = parseArgs([
    '--server-id',
    'AWS Current',
    '--management-key-file',
    '/tmp/management-key'
  ], {});

  assert.equal(options.endpoint, 'http://127.0.0.1:9527');
  assert.equal(options.localUrl, 'http://127.0.0.1:9527');
  assert.equal(options.serverId, 'aws-current');
  assert.equal(options.managementKeyFile, '/tmp/management-key');
  assert.equal(brokerProxyBase(options.endpoint, options.serverId), 'http://127.0.0.1:9527/v0/fabric/broker/servers/aws-current/proxy');
});

test('readManagementKey reads the Management Key file after env and argv are absent', () => {
  assert.equal(readManagementKey({
    managementKeyFile: '/tmp/management-key'
  }, {
    readFileSync: (file) => {
      assert.equal(file, '/tmp/management-key');
      return 'management-secret\n';
    }
  }), 'management-secret');
});

test('explicit Management Key file overrides an inherited environment key', () => {
  const options = parseArgs([
    '--management-key-file',
    '/tmp/management-key'
  ], { AIH_MANAGEMENT_KEY: 'inherited-environment-key' });

  assert.equal(readManagementKey(options, {
    readFileSync: () => 'explicit-file-key\n'
  }), 'explicit-file-key');
});

test('legacy token flags remain hidden aliases for Management Key parsing', () => {
  assert.equal(parseArgs(['--token', 'legacy-secret'], {}).managementKey, 'legacy-secret');
  assert.equal(parseArgs(['--token-file', '/tmp/legacy-secret'], {}).managementKeyFile, '/tmp/legacy-secret');
});

test('real Fabric script help exposes only Management Key credentials', () => {
  const scripts = [
    'fabric-real-broker-smoke.js',
    'fabric-real-broker-diagnostics-smoke.js',
    'fabric-real-broker-relay-smoke.js',
    'fabric-real-session-recovery-smoke.js',
    'fabric-real-vps-deploy.js'
  ];

  scripts.forEach((script) => {
    const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', script), '--help'], {
      encoding: 'utf8'
    });
    assert.equal(result.status, 0, `${script}: ${result.stderr}`);
    assert.match(result.stdout, /Management Key/);
    assert.doesNotMatch(result.stdout, /AIH_FABRIC_BROKER_TOKEN|Broker token|--broker-token-file|--token(?:-file)?\b/i);
  });
});

test('runBrokerDiagnosticsSmoke verifies offline diagnostics and recovery', async () => {
  const connectCalls = [];
  const fetchPayloads = [
    createJsonResponse(200, { ok: true, ready: true }),
    createJsonResponse(503, {
      ok: false,
      error: 'fabric_broker_server_offline',
      brokerStatus: {
        serverId: 'aws-current',
        online: false,
        session: null,
        lastDisconnected: {
          sessionId: 'session-1',
          serverId: 'aws-current',
          disconnectReason: 'broker_server_link_closed',
          disconnectedAt: 1000
        }
      }
    }),
    createJsonResponse(200, { ok: true, ready: true })
  ];

  const result = await runBrokerDiagnosticsSmoke({
    endpoint: 'http://127.0.0.1:9527',
    serverId: 'aws-current',
    managementKey: 'management-secret',
    timeoutMs: 1000
  }, {
    connectFabricBroker: async (options) => {
      connectCalls.push(options);
      const attempt = connectCalls.length;
      return {
        sessionId: `session-${attempt}`,
        closed: Promise.resolve({
          ok: true,
          reason: 'closed',
          code: 1000,
          disconnectedAt: 1000 + attempt
        }),
        close: () => {}
      };
    },
    fetchImpl: async (url) => {
      assert.equal(url, 'http://127.0.0.1:9527/v0/fabric/broker/servers/aws-current/proxy/readyz');
      return fetchPayloads.shift();
    }
  });

  assert.equal(result.ok, true);
  assert.equal(connectCalls.length, 2);
  assert.equal(connectCalls.every((options) => options.managementKey === 'management-secret'), true);
  assert.equal(connectCalls.some((options) => Object.hasOwn(options, 'token')), false);
  assert.equal(result.broker.firstSessionId, 'session-1');
  assert.equal(result.broker.secondSessionId, 'session-2');
  assert.equal(result.checks.offline.error, 'fabric_broker_server_offline');
  assert.equal(result.checks.offline.brokerStatus.lastDisconnected.disconnectReason, 'broker_server_link_closed');
  assert.equal(result.checks.recovered.ready, true);
});
