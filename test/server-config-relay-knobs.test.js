'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { sanitizeServerConfig } = require('../lib/server/server-config-store');
const { parseServerConfigArgs, toPublicServerConfig } = require('../lib/server/server-config-command');
const { applyStoredServerConfigToServeOptions } = require('../lib/server/command-handler');

test('sanitizeServerConfig normalizes relay udp knobs and max attempts', () => {
  const config = sanitizeServerConfig({
    relayUdp: 'OFF',
    relayUdpAdvertiseHost: '  relay.example.com ',
    relayUdpAdvertisePort: 29527,
    relayPortMode: 'DEDICATED',
    relayListenHost: ' 0.0.0.0 ',
    maxAttempts: 99
  });
  assert.equal(config.relayUdp, 'off');
  assert.equal(config.relayUdpAdvertiseHost, 'relay.example.com');
  assert.equal(config.relayUdpAdvertisePort, 29527);
  assert.equal(config.relayPortMode, 'dedicated');
  assert.equal(config.relayListenHost, '0.0.0.0');
  assert.equal(config.maxAttempts, 32);
  assert.equal(sanitizeServerConfig({ relayUdp: 'nonsense' }).relayUdp, 'default');
});

test('parseServerConfigArgs accepts the relay/max-attempts flags', () => {
  const parsed = parseServerConfigArgs([
    'set',
    '--relay-udp', 'off',
    '--relay-udp-advertise-host', '203.0.113.9',
    '--relay-udp-advertise-port', '29527',
    '--max-attempts', '5',
    '--relay-port-mode', 'dedicated',
    '--relay-listen-host', '0.0.0.0'
  ], {});
  assert.equal(parsed.patch.relayUdp, 'off');
  assert.equal(parsed.patch.relayUdpAdvertiseHost, '203.0.113.9');
  assert.equal(parsed.patch.relayUdpAdvertisePort, 29527);
  assert.equal(parsed.patch.maxAttempts, 5);
  assert.equal(parsed.patch.relayPortMode, 'dedicated');
  assert.equal(parsed.patch.relayListenHost, '0.0.0.0');

  const cleared = parseServerConfigArgs([
    'set',
    '--clear-relay-udp-advertise-host',
    '--clear-relay-udp-advertise-port',
    '--clear-max-attempts'
  ], {});
  assert.equal(cleared.patch.relayUdpAdvertiseHost, '');
  assert.equal(cleared.patch.relayUdpAdvertisePort, 0);
  assert.equal(cleared.patch.maxAttempts, 0);

  assert.throws(() => parseServerConfigArgs(['set', '--relay-udp', 'maybe'], {}), /relay-udp/i);
  assert.throws(() => parseServerConfigArgs(['set', '--max-attempts', '0'], {}), /max-attempts/i);
});

test('stored relay/max-attempts config is applied to serve options and process env', () => {
  const previous = {
    udp: process.env.AIH_RELAY_UDP,
    host: process.env.AIH_RELAY_UDP_ADVERTISE_HOST,
    port: process.env.AIH_RELAY_UDP_ADVERTISE_PORT
  };
  try {
    const options = applyStoredServerConfigToServeOptions({}, () => ({
      relayUdp: 'off',
      relayUdpAdvertiseHost: 'relay.example.com',
      relayUdpAdvertisePort: 29527,
      relayPortMode: 'dedicated',
      relayListenHost: '0.0.0.0',
      maxAttempts: 5
    }));
    assert.equal(process.env.AIH_RELAY_UDP, '0');
    assert.equal(process.env.AIH_RELAY_UDP_ADVERTISE_HOST, 'relay.example.com');
    assert.equal(process.env.AIH_RELAY_UDP_ADVERTISE_PORT, '29527');
    assert.equal(process.env.AIH_RELAY_PORT_MODE, 'dedicated');
    assert.equal(process.env.AIH_RELAY_LISTEN_HOST, '0.0.0.0');
    assert.equal(options.maxAttempts, 5);

    // 'default' 不覆盖部署侧环境变量（drop-in 仍是 fallback 生效路径）。
    process.env.AIH_RELAY_UDP = '1';
    applyStoredServerConfigToServeOptions({}, () => ({
      relayUdp: 'default',
      relayUdpAdvertiseHost: '',
      relayUdpAdvertisePort: 0,
      relayPortMode: 'default',
      relayListenHost: '',
      maxAttempts: 0
    }));
    assert.equal(process.env.AIH_RELAY_UDP, '1');
  } finally {
    for (const [key, value] of Object.entries({ AIH_RELAY_UDP: previous.udp, AIH_RELAY_UDP_ADVERTISE_HOST: previous.host, AIH_RELAY_UDP_ADVERTISE_PORT: previous.port })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('toPublicServerConfig exposes the new knobs', () => {
  const out = toPublicServerConfig({ relayUdp: 'on', relayUdpAdvertisePort: 29527, maxAttempts: 4 });
  assert.equal(out.relayUdp, 'on');
  assert.equal(out.relayUdpAdvertisePort, 29527);
  assert.equal(out.maxAttempts, 4);
});
