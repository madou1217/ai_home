'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  handleWebUiOutboundRelayRoutes
} = require('../lib/server/webui-outbound-relay-routes');

function createContext(method, payload, overrides = {}) {
  const writes = [];
  const headers = {};
  return {
    writes,
    headers,
    context: {
      method,
      pathname: '/v0/webui/server-routes/relays',
      req: {},
      res: {
        setHeader(name, value) { headers[String(name).toLowerCase()] = value; }
      },
      fs: {},
      readRequestBody: async () => Buffer.from(JSON.stringify(payload || {})),
      writeJson(_res, statusCode, body) { writes.push({ statusCode, body }); },
      deps: {
        aiHomeDir: '/tmp/aih',
        ...overrides
      }
    }
  };
}

function privateConfig() {
  return {
    version: 1,
    relays: [{
      endpoint: 'https://tokyo.example.com',
      name: 'Tokyo',
      enabled: true,
      managementKey: 'tokyo-secret'
    }, {
      endpoint: 'https://singapore.example.com',
      name: 'Singapore',
      enabled: true,
      managementKey: 'singapore-secret'
    }]
  };
}

test('GET outbound Server routes returns public config and runtime status without Keys', async () => {
  const fixture = createContext('GET', null, {
    readOutboundRelayConfig: () => privateConfig(),
    toPublicOutboundRelayConfig: (config) => ({
      version: config.version,
      relays: config.relays.map(({ managementKey, ...relay }) => ({
        ...relay,
        managementKeyConfigured: Boolean(managementKey)
      }))
    }),
    outboundRelayManager: {
      getSnapshot: () => ({
        running: true,
        relays: [{ endpoint: 'https://tokyo.example.com', status: 'online' }]
      })
    }
  });

  assert.equal(await handleWebUiOutboundRelayRoutes(fixture.context), true);
  assert.equal(fixture.writes[0].statusCode, 200);
  assert.equal(fixture.writes[0].body.config.relays.length, 2);
  assert.equal(fixture.writes[0].body.runtime.running, true);
  assert.equal(JSON.stringify(fixture.writes).includes('tokyo-secret'), false);
  assert.equal(JSON.stringify(fixture.writes).includes('singapore-secret'), false);
});

test('PUT outbound Server routes preserves omitted existing Keys and reconciles immediately', async () => {
  const saved = [];
  const updates = [];
  const fixture = createContext('PUT', {
    relays: [{
      endpoint: 'https://tokyo.example.com',
      name: 'Tokyo renamed',
      enabled: true,
      managementKey: ''
    }, {
      endpoint: 'https://singapore.example.com',
      name: 'Singapore',
      enabled: false,
      managementKey: 'singapore-new-secret'
    }]
  }, {
    readOutboundRelayConfig: () => privateConfig(),
    writeOutboundRelayConfig: (config) => {
      saved.push(config);
      return { version: 1, relays: config.relays };
    },
    toPublicOutboundRelayConfig: (config) => ({
      version: 1,
      relays: config.relays.map((relay) => ({
        endpoint: relay.endpoint,
        name: relay.name,
        enabled: relay.enabled,
        managementKeyConfigured: Boolean(relay.managementKey)
      }))
    }),
    outboundRelayManager: {
      update: async (config) => {
        updates.push(config);
        return { running: true, relays: [] };
      }
    }
  });

  assert.equal(await handleWebUiOutboundRelayRoutes(fixture.context), true);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].relays[0].managementKey, 'tokyo-secret');
  assert.equal(saved[0].relays[1].managementKey, 'singapore-new-secret');
  assert.equal(updates.length, 1);
  assert.equal(fixture.writes[0].statusCode, 200);
  assert.equal(JSON.stringify(fixture.writes).includes('secret'), false);
  assert.equal(fixture.headers['cache-control'], 'no-store');
});

test('outbound Server route validation errors return stable safe codes', async () => {
  const fixture = createContext('PUT', { relays: [{ endpoint: 'https://only.example.com' }] }, {
    readOutboundRelayConfig: () => ({ version: 1, relays: [] }),
    writeOutboundRelayConfig: () => {
      const error = new Error('sensitive value');
      error.code = 'invalid_outbound_relay_count';
      throw error;
    }
  });

  assert.equal(await handleWebUiOutboundRelayRoutes(fixture.context), true);
  assert.deepEqual(fixture.writes, [{
    statusCode: 400,
    body: { ok: false, error: 'invalid_outbound_relay_count' }
  }]);
  assert.equal(JSON.stringify(fixture.writes).includes('sensitive value'), false);
});
