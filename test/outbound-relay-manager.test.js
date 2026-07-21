'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  createOutboundRelayManager
} = require('../lib/server/outbound-relay-manager');

const TOKYO = 'https://tokyo.example.com';
const SINGAPORE = 'https://singapore.example.com';
const SYDNEY = 'https://sydney.example.com';

test('outbound relay domain does not depend on the CLI layer', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../lib/server/outbound-relay-manager.js'),
    'utf8'
  );
  assert.doesNotMatch(source, /require\(['"]\.\.\/cli\//);
});

function relay(endpoint, name, managementKey, enabled = true) {
  return { endpoint, name, enabled, managementKey };
}

function relayConfig(relays) {
  return { relays };
}

function createHandle(endpoint, attempt) {
  let resolveClosed;
  let settled = false;
  const handle = {
    brokerUrl: endpoint,
    sessionId: `${new URL(endpoint).host}-${attempt}`,
    diagnostics: {
      connectedAt: Date.now(),
      lastHeartbeatAt: 0,
      lastPongAt: 0
    },
    closeCalls: 0,
    closed: new Promise((resolve) => {
      resolveClosed = resolve;
    }),
    disconnect(result = {}) {
      if (settled) return;
      settled = true;
      resolveClosed({
        ok: true,
        reason: 'closed',
        code: 1006,
        closeReason: 'network drop',
        ...result
      });
    },
    close() {
      handle.closeCalls += 1;
      handle.disconnect({ code: 1000, closeReason: 'manager stop' });
    }
  };
  return handle;
}

function createControlledSleep() {
  const waits = [];
  return {
    waits,
    sleep(delayMs, context) {
      return new Promise((resolve) => {
        waits.push({ delayMs, ...context, resolve });
      });
    }
  };
}

async function waitFor(predicate, message = 'condition_not_met') {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}

function createManager(deps = {}, input = {}) {
  return createOutboundRelayManager({
    stableServerId: 'local-home',
    localUrl: 'http://127.0.0.1:9527/',
    connectTimeoutMs: 1000,
    heartbeatMs: 5000,
    reconnectDelayMs: 100,
    reconnectMaxDelayMs: 800,
    reconnectJitterRatio: 0,
    ...input
  }, {
    random: () => 0.5,
    ...deps
  });
}

test('outbound relay keeps the local client key inside the connector boundary', async (t) => {
  const calls = [];
  const manager = createManager({
    connectFabricBroker: async (options) => {
      calls.push(options);
      return createHandle(options.brokerUrl, 1);
    }
  }, { localClientKey: 'local-client-secret' });
  t.after(() => manager.stop());

  await manager.start(relayConfig([relay(TOKYO, 'Tokyo', 'tokyo-key')]));
  await waitFor(() => calls.length === 1);

  assert.equal(calls[0].localClientKey, 'local-client-secret');
  assert.equal(JSON.stringify(manager.getSnapshot()).includes('local-client-secret'), false);
});

test('outbound relay forwards the AI gateway first-response timeout to the connector', async (t) => {
  const calls = [];
  const manager = createManager({
    connectFabricBroker: async (options) => {
      calls.push(options);
      return createHandle(options.brokerUrl, 1);
    }
  }, { requestTimeoutMs: 120_000 });
  t.after(() => manager.stop());

  await manager.start(relayConfig([relay(TOKYO, 'Tokyo', 'tokyo-key')]));
  await waitFor(() => calls.length === 1);

  assert.equal(calls[0].requestTimeoutMs, 120_000);
});

test('outbound relay manager reconnects each AWS independently with capped exponential backoff', async (t) => {
  const controlled = createControlledSleep();
  const calls = [];
  const handles = [];
  const manager = createManager({
    sleep: controlled.sleep,
    connectFabricBroker: async (options) => {
      calls.push(options);
      const attempt = calls.filter((call) => call.brokerUrl === options.brokerUrl).length;
      const handle = createHandle(options.brokerUrl, attempt);
      handles.push(handle);
      return handle;
    }
  });
  t.after(() => manager.stop());

  await manager.start(relayConfig([
    relay(TOKYO, 'Tokyo', 'tokyo-key'),
    relay(SINGAPORE, 'Singapore', 'singapore-key')
  ]));
  await waitFor(() => calls.length === 2, 'both AWS relays were not connected');

  assert.deepEqual(calls.map((call) => ({
    brokerUrl: call.brokerUrl,
    serverId: call.serverId,
    localUrl: call.localUrl,
    managementKey: call.managementKey,
    connectTimeoutMs: call.connectTimeoutMs,
    heartbeatMs: call.heartbeatMs
  })), [{
    brokerUrl: TOKYO,
    serverId: 'local-home',
    localUrl: 'http://127.0.0.1:9527',
    managementKey: 'tokyo-key',
    connectTimeoutMs: 1000,
    heartbeatMs: 5000
  }, {
    brokerUrl: SINGAPORE,
    serverId: 'local-home',
    localUrl: 'http://127.0.0.1:9527',
    managementKey: 'singapore-key',
    connectTimeoutMs: 1000,
    heartbeatMs: 5000
  }]);

  handles.find((handle) => handle.brokerUrl === TOKYO).disconnect();
  await waitFor(() => controlled.waits.length === 1, 'Tokyo retry was not scheduled');
  assert.equal(controlled.waits[0].endpoint, TOKYO);
  assert.equal(controlled.waits[0].delayMs, 100);
  const waitingTokyo = manager.getSnapshot().relays.find((item) => item.endpoint === TOKYO);
  assert.equal(waitingTokyo.status, 'waiting');
  assert.equal(waitingTokyo.sessionId, '');
  controlled.waits[0].resolve();
  await waitFor(() => calls.filter((call) => call.brokerUrl === TOKYO).length === 2);
  assert.equal(calls.filter((call) => call.brokerUrl === SINGAPORE).length, 1);

  handles.filter((handle) => handle.brokerUrl === TOKYO)[1].disconnect();
  await waitFor(() => controlled.waits.length === 2, 'second Tokyo retry was not scheduled');
  assert.equal(controlled.waits[1].endpoint, TOKYO);
  assert.equal(controlled.waits[1].delayMs, 200);
});

test('stop cancels pending retry sleeps and closes every active AWS socket', async () => {
  const controlled = createControlledSleep();
  const handles = [];
  const manager = createManager({
    sleep: controlled.sleep,
    connectFabricBroker: async (options) => {
      const handle = createHandle(options.brokerUrl, 1);
      handles.push(handle);
      return handle;
    }
  });

  await manager.start(relayConfig([
    relay(TOKYO, 'Tokyo', 'tokyo-key'),
    relay(SINGAPORE, 'Singapore', 'singapore-key')
  ]));
  await waitFor(() => handles.length === 2);
  handles.find((handle) => handle.brokerUrl === TOKYO).disconnect();
  await waitFor(() => controlled.waits.length === 1);

  await manager.stop();

  assert.equal(controlled.waits[0].signal.aborted, true);
  assert.equal(handles.find((handle) => handle.brokerUrl === SINGAPORE).closeCalls, 1);
  assert.equal(manager.getSnapshot().running, false);
  assert.deepEqual(manager.getSnapshot().relays.map((item) => item.status), ['stopped', 'stopped']);
});

test('update reconciles changed Keys, disabled relays, and new endpoints without restarting unchanged links', async (t) => {
  const calls = [];
  const handles = [];
  const manager = createManager({
    connectFabricBroker: async (options) => {
      calls.push(options);
      const handle = createHandle(options.brokerUrl, calls.length);
      handles.push(handle);
      return handle;
    }
  });
  t.after(() => manager.stop());

  await manager.start(relayConfig([
    relay(TOKYO, 'Tokyo', 'tokyo-key-v1'),
    relay(SINGAPORE, 'Singapore', 'singapore-key')
  ]));
  await waitFor(() => calls.length === 2);
  const originalTokyo = handles.find((handle) => handle.brokerUrl === TOKYO);
  const originalSingapore = handles.find((handle) => handle.brokerUrl === SINGAPORE);

  await manager.update(relayConfig([
    relay(TOKYO, 'Tokyo', 'tokyo-key-v2'),
    relay(SINGAPORE, 'Singapore', 'singapore-key', false),
    relay(SYDNEY, 'Sydney', 'sydney-key')
  ]));
  await waitFor(() => calls.length === 4);

  assert.equal(originalTokyo.closeCalls, 1);
  assert.equal(originalSingapore.closeCalls, 1);
  assert.equal(calls.filter((call) => call.brokerUrl === TOKYO).length, 2);
  assert.equal(calls.findLast((call) => call.brokerUrl === TOKYO).managementKey, 'tokyo-key-v2');
  assert.equal(calls.filter((call) => call.brokerUrl === SINGAPORE).length, 1);
  assert.equal(calls.filter((call) => call.brokerUrl === SYDNEY).length, 1);

  await manager.reconcile(relayConfig([
    relay(TOKYO, 'Tokyo renamed', 'tokyo-key-v2'),
    relay(SINGAPORE, 'Singapore', 'singapore-key', false),
    relay(SYDNEY, 'Sydney renamed', 'sydney-key')
  ]));
  assert.equal(calls.length, 4);

  const snapshot = manager.getSnapshot();
  assert.equal(snapshot.relays.find((item) => item.endpoint === TOKYO).name, 'Tokyo renamed');
  assert.equal(snapshot.relays.find((item) => item.endpoint === SINGAPORE).status, 'disabled');
  assert.equal(snapshot.relays.find((item) => item.endpoint === SYDNEY).name, 'Sydney renamed');
  assert.equal(JSON.stringify(snapshot).includes('key-v2'), false);
  assert.equal(JSON.stringify(snapshot).includes('managementKey"'), false);
  assert.equal(snapshot.relays.every((item) => item.managementKeyConfigured === true), true);
});

test('outbound relay manager requires stable Server identity and a local HTTP URL', () => {
  assert.throws(() => createOutboundRelayManager({
    localUrl: 'http://127.0.0.1:9527'
  }), (error) => error && error.code === 'missing_outbound_relay_server_id');
  assert.throws(() => createOutboundRelayManager({
    stableServerId: 'local-home',
    localUrl: 'file:///tmp/server.sock'
  }), (error) => error && error.code === 'invalid_outbound_relay_local_url');
});
