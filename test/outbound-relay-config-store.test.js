'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  OUTBOUND_RELAY_CONFIG_KEY,
  readOutboundRelayConfig,
  readPublicOutboundRelayConfig,
  writeOutboundRelayConfig
} = require('../lib/server/outbound-relay-config-store');
const { readJsonValue } = require('../lib/server/app-state-store');

function createFixture(t) {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-outbound-relays-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  return { fs, aiHomeDir };
}

test('outbound relay config persists two normalized AWS endpoints with Management Keys in app-state', (t) => {
  const deps = createFixture(t);

  const saved = writeOutboundRelayConfig({
    relays: [{
      endpoint: 'https://tokyo.example.com/',
      name: 'Tokyo',
      enabled: true,
      managementKey: 'tokyo-secret'
    }, {
      endpoint: 'wss://singapore.example.com',
      name: 'Singapore',
      enabled: false,
      managementKey: 'singapore-secret'
    }]
  }, deps);

  assert.deepEqual(saved, {
    version: 1,
    relays: [{
      endpoint: 'https://tokyo.example.com',
      name: 'Tokyo',
      enabled: true,
      managementKey: 'tokyo-secret'
    }, {
      endpoint: 'wss://singapore.example.com',
      name: 'Singapore',
      enabled: false,
      managementKey: 'singapore-secret'
    }]
  });
  assert.deepEqual(readOutboundRelayConfig(deps), saved);
  assert.deepEqual(readJsonValue(fs, deps.aiHomeDir, OUTBOUND_RELAY_CONFIG_KEY), saved);
});

test('public outbound relay config exposes only whether each Management Key is configured', (t) => {
  const deps = createFixture(t);
  writeOutboundRelayConfig({
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
  }, deps);

  const publicConfig = readPublicOutboundRelayConfig(deps);

  assert.deepEqual(publicConfig, {
    version: 1,
    relays: [{
      endpoint: 'https://tokyo.example.com',
      name: 'Tokyo',
      enabled: true,
      managementKeyConfigured: true
    }, {
      endpoint: 'https://singapore.example.com',
      name: 'Singapore',
      enabled: true,
      managementKeyConfigured: true
    }]
  });
  assert.equal(JSON.stringify(publicConfig).includes('secret'), false);
  assert.equal(JSON.stringify(publicConfig).includes('managementKey"'), false);
});

test('outbound relay config accepts empty or one relay and rejects duplicate, invalid, or more than five relays', (t) => {
  const deps = createFixture(t);

  assert.deepEqual(writeOutboundRelayConfig([], deps), { version: 1, relays: [] });
  assert.throws(() => writeOutboundRelayConfig({ relays: 'not-an-array' }, deps), (error) => (
    error && error.code === 'invalid_outbound_relay_config'
  ));
  assert.deepEqual(writeOutboundRelayConfig([{
    endpoint: 'https://only.example.com',
    name: 'Only',
    enabled: true,
    managementKey: 'secret'
  }], deps), {
    version: 1,
    relays: [{
      endpoint: 'https://only.example.com',
      name: 'Only',
      enabled: true,
      managementKey: 'secret'
    }]
  });
  assert.throws(() => writeOutboundRelayConfig([
    { endpoint: 'https://same.example.com', name: 'First', enabled: true, managementKey: 'one' },
    { endpoint: 'https://same.example.com/', name: 'Second', enabled: true, managementKey: 'two' }
  ], deps), (error) => error && error.code === 'duplicate_outbound_relay_endpoint');
  assert.throws(() => writeOutboundRelayConfig([
    { endpoint: 'file:///tmp/relay', name: 'Invalid', enabled: true, managementKey: 'one' },
    { endpoint: 'https://valid.example.com', name: 'Valid', enabled: true, managementKey: 'two' }
  ], deps), (error) => error && error.code === 'invalid_outbound_relay_endpoint');
  assert.throws(() => writeOutboundRelayConfig([
    { endpoint: 'https://a.example.com', name: 'A', enabled: true, managementKey: 'a' },
    { endpoint: 'https://b.example.com', name: 'B', enabled: true, managementKey: '' }
  ], deps), (error) => error && error.code === 'missing_outbound_relay_management_key');
  assert.throws(() => writeOutboundRelayConfig(Array.from({ length: 6 }, (_value, index) => ({
    endpoint: `https://${index}.example.com`,
    name: String(index),
    enabled: true,
    managementKey: `key-${index}`
  })), deps), (error) => error && error.code === 'invalid_outbound_relay_count');
});
