'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  parseArgs,
  readBrokerToken,
  runBrokerRelaySmoke
} = require('../scripts/fabric-real-broker-relay-smoke');

test('parseArgs builds default broker proxy client endpoint for default 9527', () => {
  const options = parseArgs([
    '--server-id',
    'AWS Current',
    '--node-id',
    'aws-current-node',
    '--token-file',
    '/tmp/broker-token',
    '--host-home',
    '/tmp/aih-host'
  ], {
    HOME: '/tmp/home'
  });

  assert.equal(options.endpoint, 'http://127.0.0.1:9527');
  assert.equal(options.localUrl, 'http://127.0.0.1:9527');
  assert.equal(options.clientEndpoint, 'http://127.0.0.1:9527/v0/fabric/broker/servers/aws-current/proxy');
  assert.equal(options.serverId, 'aws-current');
  assert.equal(options.nodeId, 'aws-current-node');
  assert.equal(options.tokenFile, '/tmp/broker-token');
  assert.equal(options.hostHome, '/tmp/aih-host');
});

test('parseArgs accepts explicit client endpoint and rejects missing broker token source', () => {
  const options = parseArgs([
    '--endpoint',
    'http://127.0.0.1:9527/',
    '--client-endpoint',
    'http://127.0.0.1:9527/v0/fabric/broker/servers/custom/proxy/',
    '--server-id',
    'custom',
    '--token',
    'token',
    '--host-home',
    '/tmp/aih-host'
  ], {
    HOME: '/tmp/home'
  });

  assert.equal(options.clientEndpoint, 'http://127.0.0.1:9527/v0/fabric/broker/servers/custom/proxy');
  assert.throws(
    () => parseArgs(['--host-home', '/tmp/aih-host'], { HOME: '/tmp/home' }),
    /missing broker token/
  );
});

test('readBrokerToken reads token from file without requiring argv token', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-broker-relay-token-'));
  const tokenFile = path.join(tempRoot, 'broker-token');
  fs.writeFileSync(tokenFile, 'secret-token\n');

  assert.equal(readBrokerToken({ tokenFile }), 'secret-token');
});

test('runBrokerRelaySmoke keeps broker link online for relay smoke and closes it', async () => {
  const calls = {
    broker: null,
    relay: null,
    closed: false
  };

  const result = await runBrokerRelaySmoke({
    endpoint: 'http://127.0.0.1:9527',
    serverId: 'aws-current',
    nodeId: 'aws-current-node',
    hostHome: '/tmp/aih-host',
    token: 'secret-token',
    timeoutMs: 5000
  }, {
    connectFabricBroker: async (options) => {
      calls.broker = options;
      return {
        sessionId: 'broker-session-1',
        close: () => {
          calls.closed = true;
        }
      };
    },
    runExistingEndpointRelaySmoke: async (options) => {
      calls.relay = options;
      return {
        ok: true,
        mode: 'existing-endpoint-relay',
        control: { endpoint: options.endpoint },
        client: { endpoint: options.clientEndpoint }
      };
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.broker.sessionId, 'broker-session-1');
  assert.equal(calls.closed, true);
  assert.equal(calls.broker.brokerUrl, 'http://127.0.0.1:9527');
  assert.equal(calls.broker.localUrl, 'http://127.0.0.1:9527');
  assert.equal(calls.broker.token, 'secret-token');
  assert.equal(calls.relay.endpoint, 'http://127.0.0.1:9527');
  assert.equal(calls.relay.clientEndpoint, 'http://127.0.0.1:9527/v0/fabric/broker/servers/aws-current/proxy');
  assert.equal(result.relay.client.endpoint, calls.relay.clientEndpoint);
});
