'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  brokerProxyBase,
  parseArgs,
  readBrokerToken,
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
    '--token-file',
    '/tmp/broker-token'
  ], {});

  assert.equal(options.endpoint, 'http://127.0.0.1:9527');
  assert.equal(options.localUrl, 'http://127.0.0.1:9527');
  assert.equal(options.serverId, 'aws-current');
  assert.equal(options.tokenFile, '/tmp/broker-token');
  assert.equal(brokerProxyBase(options.endpoint, options.serverId), 'http://127.0.0.1:9527/v0/fabric/broker/servers/aws-current/proxy');
});

test('readBrokerToken reads token file after env and argv are absent', () => {
  assert.equal(readBrokerToken({
    tokenFile: '/tmp/token'
  }, {
    readFileSync: (file) => {
      assert.equal(file, '/tmp/token');
      return 'secret-token\n';
    }
  }), 'secret-token');
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
    token: 'secret-token',
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
  assert.equal(result.broker.firstSessionId, 'session-1');
  assert.equal(result.broker.secondSessionId, 'session-2');
  assert.equal(result.checks.offline.error, 'fabric_broker_server_offline');
  assert.equal(result.checks.offline.brokerStatus.lastDisconnected.disconnectReason, 'broker_server_link_closed');
  assert.equal(result.checks.recovered.ready, true);
});
