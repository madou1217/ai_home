'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  calculateBrokerReconnectDelay,
  parseFabricBrokerConnectArgs,
  runFabricBrokerConnect
} = require('../lib/cli/services/fabric/broker-connect');

function closedHandle(options, attempt) {
  return {
    serverId: options.serverId,
    brokerUrl: options.brokerUrl,
    localUrl: options.localUrl,
    sessionId: `${new URL(options.brokerUrl).host}-${attempt}`,
    diagnostics: {},
    closed: Promise.resolve({
      ok: true,
      reason: 'closed',
      code: 1006,
      closeReason: 'network drop'
    }),
    close() {}
  };
}

test('broker connect accepts two to five AWS endpoints with their Management Keys', () => {
  const options = parseFabricBrokerConnectArgs([
    'https://tokyo.example.com',
    'https://singapore.example.com',
    '--server-id',
    'Local Home',
    '--management-key',
    'tokyo-key',
    '--management-key',
    'singapore-key'
  ], { env: {} });

  assert.deepEqual(options.brokers, [{
    brokerUrl: 'wss://tokyo.example.com/v0/fabric/broker/control',
    managementKey: 'tokyo-key'
  }, {
    brokerUrl: 'wss://singapore.example.com/v0/fabric/broker/control',
    managementKey: 'singapore-key'
  }]);
  assert.equal(options.brokerUrl, options.brokers[0].brokerUrl);
  assert.equal(options.managementKey, 'tokyo-key');
  assert.equal(Object.hasOwn(options, 'token'), false);
  assert.throws(() => parseFabricBrokerConnectArgs([
    'https://a.example.com',
    'https://b.example.com',
    '--server-id',
    'local-home',
    '--management-key',
    'only-one',
    '--management-key',
    'second',
    '--management-key',
    'extra'
  ], { env: {} }), /management_key_count_mismatch/);
});

test('single endpoint keeps the legacy --token argument as a Management Key alias', () => {
  const options = parseFabricBrokerConnectArgs([
    'https://aws.example.com',
    '--server-id',
    'Local Home',
    '--token',
    'aws-management-key'
  ], { env: {} });

  assert.equal(options.managementKey, 'aws-management-key');
  assert.deepEqual(options.brokers, [{
    brokerUrl: 'wss://aws.example.com/v0/fabric/broker/control',
    managementKey: 'aws-management-key'
  }]);
});

test('reconnect delay uses capped exponential backoff with jitter', () => {
  const options = {
    reconnectDelayMs: 1000,
    reconnectMaxDelayMs: 5000,
    reconnectJitterRatio: 0.2
  };

  assert.equal(calculateBrokerReconnectDelay(1, options, () => 0), 800);
  assert.equal(calculateBrokerReconnectDelay(2, options, () => 0.5), 2000);
  assert.equal(calculateBrokerReconnectDelay(4, options, () => 1), 5000);
  assert.equal(calculateBrokerReconnectDelay(1, {
    reconnectDelayMs: 1000,
    reconnectMaxDelayMs: 5000
  }, () => 0), 800);
});

test('multiple AWS links reconnect independently', async () => {
  const attempts = new Map();
  const sleeps = [];
  const result = await runFabricBrokerConnect([
    'https://tokyo.example.com',
    'https://singapore.example.com',
    '--server-id',
    'local-home',
    '--management-key',
    'tokyo-key',
    '--management-key',
    'singapore-key',
    '--max-attempts',
    '2',
    '--reconnect-delay-ms',
    '1000',
    '--json'
  ], {
    env: {},
    random: () => 0.5,
    sleep: async (delayMs, options) => {
      sleeps.push({ delayMs, brokerUrl: options.brokerUrl });
    },
    connectFabricBroker: async (options) => {
      const attempt = (attempts.get(options.brokerUrl) || 0) + 1;
      attempts.set(options.brokerUrl, attempt);
      if (options.brokerUrl.includes('tokyo') && attempt === 1) {
        const error = new Error('tokyo unavailable');
        error.code = 'ECONNREFUSED';
        throw error;
      }
      return closedHandle(options, attempt);
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.mode, 'multi-broker');
  assert.equal(result.connections.length, 2);
  assert.equal(attempts.get('wss://tokyo.example.com/v0/fabric/broker/control'), 2);
  assert.equal(attempts.get('wss://singapore.example.com/v0/fabric/broker/control'), 2);
  assert.deepEqual(sleeps, [{
    delayMs: 1000,
    brokerUrl: 'wss://tokyo.example.com/v0/fabric/broker/control'
  }, {
    delayMs: 1000,
    brokerUrl: 'wss://singapore.example.com/v0/fabric/broker/control'
  }]);
});
