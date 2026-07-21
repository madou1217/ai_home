'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  parseArgs,
  readManagementKey,
  runBrokerRelaySmoke
} = require('../scripts/fabric-real-broker-relay-smoke');

const ACCOUNT_REF = 'acct_11111111111111111111';

test('parseArgs builds default broker proxy client endpoint for default 9527', () => {
  const options = parseArgs([
    '--server-id',
    'AWS Current',
    '--node-id',
    'aws-current-node',
    '--management-key-file',
    '/tmp/management-key',
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
  assert.equal(options.managementKeyFile, '/tmp/management-key');
  assert.equal(options.hostHome, '/tmp/aih-host');
});

test('parseArgs accepts explicit client endpoint and rejects a missing Management Key source', () => {
  const options = parseArgs([
    '--endpoint',
    'http://127.0.0.1:9527/',
    '--client-endpoint',
    'http://127.0.0.1:9527/v0/fabric/broker/servers/custom/proxy/',
    '--server-id',
    'custom',
    '--management-key',
    'management-secret',
    '--host-home',
    '/tmp/aih-host'
  ], {
    HOME: '/tmp/home'
  });

  assert.equal(options.clientEndpoint, 'http://127.0.0.1:9527/v0/fabric/broker/servers/custom/proxy');
  assert.throws(
    () => parseArgs(['--host-home', '/tmp/aih-host'], { HOME: '/tmp/home' }),
    /missing Management Key/
  );
});

test('parseArgs accepts only accountRef for an explicit session target', () => {
  const options = parseArgs([
    '--management-key',
    'management-secret',
    '--host-home',
    '/tmp/aih-host',
    '--session-account-ref',
    ACCOUNT_REF
  ], { HOME: '/tmp/home' });

  assert.equal(options.sessionAccountRef, ACCOUNT_REF);
  assert.throws(
    () => parseArgs([
      '--management-key',
      'management-secret',
      '--host-home',
      '/tmp/aih-host',
      '--session-account-ref',
      '1'
    ], { HOME: '/tmp/home' }),
    /must be a valid accountRef/
  );
});

test('readManagementKey reads a key from file without requiring an argv secret', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-broker-relay-management-key-'));
  const managementKeyFile = path.join(tempRoot, 'management-key');
  fs.writeFileSync(managementKeyFile, 'management-secret\n');

  assert.equal(readManagementKey({ managementKeyFile }), 'management-secret');
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
    managementKey: 'management-secret',
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
  assert.equal(calls.broker.managementKey, 'management-secret');
  assert.equal(Object.hasOwn(calls.broker, 'token'), false);
  assert.equal(calls.relay.endpoint, 'http://127.0.0.1:9527');
  assert.equal(calls.relay.clientEndpoint, 'http://127.0.0.1:9527/v0/fabric/broker/servers/aws-current/proxy');
  assert.equal(result.relay.client.endpoint, calls.relay.clientEndpoint);
});
