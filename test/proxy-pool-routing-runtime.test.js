'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { ProxyPoolService } = require('../lib/cli/services/toolkit/proxy-pool/proxy-pool-service');

function createStore() {
  const node = {
    id: 'node_http',
    name: 'HTTP',
    protocol: 'http',
    server: '198.51.100.20',
    port: 8080
  };
  let routing = { mode: 'direct', activeOutboundNodeId: null, rules: [] };
  const mappings = {};
  return {
    node,
    listNodes() { return [node]; },
    listGroups() { return []; },
    getNode(id) { return id === node.id ? node : null; },
    getRoutingConfig() { return routing; },
    setRoutingConfig(update) { routing = { ...routing, ...update }; return routing; },
    getDedicatedPortsConfig() {
      return { enabled: true, maxPorts: 32, basePort: 10801, mappings: { ...mappings } };
    },
    assignDedicatedPort(nodeId, port) { mappings[nodeId] = port || 10801; return { ok: true, port: mappings[nodeId] }; },
    releaseDedicatedPort(nodeId) { delete mappings[nodeId]; return { ok: true }; },
    get mappings() { return { ...mappings }; }
  };
}

test('routing remains desired-only when Mihomo rejects reload', async () => {
  const store = createStore();
  const status = {
    engine: 'mihomo', installed: true, running: true, dataPlaneReady: true,
    mixedProxyUrl: 'http://127.0.0.1:10800', activeListeners: []
  };
  const coreRuntime = {
    getStatus() { return status; },
    async reload() {
      return { ok: false, applied: false, error: 'mihomo_config_invalid', core: status, warnings: [] };
    }
  };
  const service = new ProxyPoolService({ store, coreRuntime });

  const result = await service.updateRouting({
    mode: 'global',
    activeOutboundNodeId: store.node.id,
    rules: []
  });

  assert.equal(result.ok, true);
  assert.equal(result.applied, false);
  assert.equal(result.error, 'mihomo_config_invalid');
  assert.equal(result.desired.mode, 'global');
  assert.equal(store.getRoutingConfig().mode, 'global');
});

for (const [serviceAction, runtimeAction] of [
  ['startCore', 'start'],
  ['reloadCore', 'reload']
]) {
  test(`${serviceAction} reports routing fallback as not applied`, async () => {
    const store = createStore();
    const status = {
      engine: 'mihomo', installed: true, running: true, dataPlaneReady: true,
      mixedProxyUrl: 'http://127.0.0.1:10800', activeListeners: []
    };
    const coreRuntime = {
      getStatus() { return status; },
      async [runtimeAction]() {
        return {
          ok: true,
          applied: true,
          action: runtimeAction,
          core: status,
          warnings: ['routing_active_outbound_missing']
        };
      }
    };
    const service = new ProxyPoolService({ store, coreRuntime });

    const result = await service[serviceAction]();

    assert.equal(result.ok, true);
    assert.equal(result.applied, false);
    assert.equal(result.error, 'routing_not_fully_applied');
  });
}

test('dedicated mapping is rolled back when Mihomo does not expose the listener as ready', async () => {
  const store = createStore();
  const status = {
    engine: 'mihomo', installed: true, running: true, dataPlaneReady: true,
    mixedProxyUrl: 'http://127.0.0.1:10800', activeListeners: []
  };
  const coreRuntime = {
    getStatus() { return status; },
    async reload() { return { ok: true, applied: true, core: status, warnings: [] }; }
  };
  const service = new ProxyPoolService({ store, coreRuntime });

  const result = await service.toggleDedicatedPort(store.node.id, true, 10801);

  assert.equal(result.ok, false);
  assert.equal(result.error, 'proxy_core_readiness_failed');
  assert.deepEqual(store.mappings, {});
});

test('dedicated mapping is rolled back when Mihomo reports applied false', async () => {
  const store = createStore();
  const status = {
    engine: 'mihomo', installed: true, running: true, dataPlaneReady: true,
    mixedProxyUrl: 'http://127.0.0.1:10800',
    activeListeners: [{ nodeId: store.node.id, port: 10801, listening: true }]
  };
  let reloadCount = 0;
  const coreRuntime = {
    getStatus() { return status; },
    async reload() {
      reloadCount += 1;
      return reloadCount === 1
        ? { ok: true, applied: false, error: 'proxy_core_readiness_failed', core: status, warnings: [] }
        : { ok: true, applied: true, core: status, warnings: [] };
    }
  };
  const service = new ProxyPoolService({ store, coreRuntime });

  const result = await service.toggleDedicatedPort(store.node.id, true, 10801);

  assert.equal(result.ok, false);
  assert.equal(result.applied, false);
  assert.equal(result.error, 'proxy_core_readiness_failed');
  assert.equal(reloadCount, 2);
  assert.deepEqual(store.mappings, {});
});

test('dedicated mapping is rolled back when Mihomo falls back from invalid routing', async () => {
  const store = createStore();
  const status = {
    engine: 'mihomo', installed: true, running: true, dataPlaneReady: true,
    mixedProxyUrl: 'http://127.0.0.1:10800',
    activeListeners: [{ nodeId: store.node.id, port: 10801, listening: true }]
  };
  let reloadCount = 0;
  const coreRuntime = {
    getStatus() { return status; },
    async reload() {
      reloadCount += 1;
      return reloadCount === 1
        ? { ok: true, applied: true, core: status, warnings: ['routing_active_outbound_missing'] }
        : { ok: true, applied: true, core: status, warnings: [] };
    }
  };
  const service = new ProxyPoolService({ store, coreRuntime });

  const result = await service.toggleDedicatedPort(store.node.id, true, 10801);

  assert.equal(result.ok, false);
  assert.equal(result.applied, false);
  assert.equal(result.error, 'routing_not_fully_applied');
  assert.equal(reloadCount, 2);
  assert.deepEqual(store.mappings, {});
});

test('dedicated port allocation skips an occupied default loopback port before compiling Mihomo listeners', async () => {
  const store = createStore();
  const status = {
    engine: 'mihomo', installed: true, running: true, dataPlaneReady: true,
    mixedProxyUrl: 'http://127.0.0.1:10800', activeListeners: []
  };
  const coreRuntime = {
    getStatus() { return status; },
    async reload(state) {
      status.activeListeners = Object.entries(state.dedicatedPorts.mappings).map(([nodeId, port]) => ({ nodeId, port, listening: true }));
      return { ok: true, applied: true, core: status, warnings: [] };
    }
  };
  const service = new ProxyPoolService({
    store,
    coreRuntime,
    portManager: undefined
  });
  // Replace the injected manager's chooser to model a real foreign listener on 10801.
  service.portManager.choosePort = async (preferred, options) => {
    assert.equal(preferred, 10801);
    assert.equal(options.reservedPorts.includes(10800), true);
    return { ok: true, port: 10802, requestedPort: 10801, reused: false, reason: 'preferred_port_in_use' };
  };

  const result = await service.toggleDedicatedPort(store.node.id, true);

  assert.equal(result.ok, true);
  assert.equal(result.applied, true);
  assert.equal(result.port, 10802);
  assert.equal(store.mappings[store.node.id], 10802);
});
