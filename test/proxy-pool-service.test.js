'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const { ProxyNodeStore } = require('../lib/cli/services/toolkit/proxy-pool/proxy-node-store');
const {
  ProxyPoolService,
  closeDefaultProxyPoolService
} = require('../lib/cli/services/toolkit/proxy-pool/proxy-pool-service');
const { RoutingManager } = require('../lib/cli/services/toolkit/proxy-pool/routing-manager');

function createInjectedStore(nodes = []) {
  const records = new Map(nodes.map((node) => [node.id, { ...node }]));
  const dedicatedMappings = new Map();
  const latencyUpdates = [];
  let bulkUpsertCalls = 0;
  let routing = {
    mode: 'rule',
    activeOutboundNodeId: null,
    rules: []
  };

  return {
    listNodes() {
      return Array.from(records.values());
    },
    getNode(nodeId) {
      return records.get(nodeId) || null;
    },
    bulkUpsertNodes(importedNodes) {
      bulkUpsertCalls += 1;
      for (const node of importedNodes) {
        records.set(node.id || `node_${records.size + 1}`, { ...node });
      }
      return importedNodes;
    },
    listGroups() {
      return [];
    },
    getRoutingConfig() {
      return routing;
    },
    setRoutingConfig(update) {
      routing = { ...routing, ...update };
      return routing;
    },
    getDedicatedPortsConfig() {
      return {
        enabled: true,
        maxPorts: 32,
        basePort: 10801,
        mappings: Object.fromEntries(dedicatedMappings)
      };
    },
    assignDedicatedPort(nodeId, requestedPort = 10801) {
      dedicatedMappings.set(nodeId, requestedPort);
      return { ok: true, port: requestedPort };
    },
    releaseDedicatedPort(nodeId) {
      dedicatedMappings.delete(nodeId);
      return true;
    },
    updateNodeLatency(nodeId, latencyMs) {
      latencyUpdates.push({ nodeId, latencyMs });
    },
    get bulkUpsertCalls() {
      return bulkUpsertCalls;
    },
    get dedicatedMappingCount() {
      return dedicatedMappings.size;
    },
    get latencyUpdates() {
      return [...latencyUpdates];
    }
  };
}

function createUnavailableCoreRuntime() {
  let pingCalls = 0;
  return {
    getStatus() {
      return {
        engine: 'mihomo',
        installed: false,
        running: false,
        dataPlaneReady: false
      };
    },
    async pingNode() {
      pingCalls += 1;
      throw new Error('unavailable core must not be asked to probe a node');
    },
    get pingCalls() {
      return pingCalls;
    }
  };
}

function createInjectedService(store, coreRuntime) {
  const service = new ProxyPoolService({ store, coreRuntime });
  assert.equal(service.store, store, 'ProxyPoolService must use the injected store');
  assert.equal(service.coreRuntime, coreRuntime, 'ProxyPoolService must use the injected core runtime');
  return service;
}

function createDeferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('ProxyNodeStore handles node CRUD, subscriptions, and dedicated ports limits', () => {
  const tempFile = path.join(os.tmpdir(), `aih-test-proxy-pool-${Date.now()}.json`);
  const store = new ProxyNodeStore(tempFile);

  try {
    // 1. Add node
    const node = store.upsertNode({
      name: 'Test HK Node',
      protocol: 'shadowsocks',
      server: '1.1.1.1',
      port: 8388,
      countryCode: 'HK'
    });
    assert.ok(node.id);
    assert.equal(store.listNodes().length, 1);

    // 2. Assign dedicated port
    const portRes = store.assignDedicatedPort(node.id);
    assert.ok(portRes.ok);
    assert.equal(portRes.port, 10801);

    // 3. Test Max limit guard
    store.setDedicatedPortsConfig({ maxPorts: 1 });
    const portRes2 = store.assignDedicatedPort('node_other');
    assert.equal(portRes2.ok, false);
    assert.ok(portRes2.error.includes('上限'));

    // 4. Subscriptions
    const sub = store.upsertSubscription({
      name: 'Test Sub',
      url: 'https://example.com/sub'
    });
    assert.ok(sub.id);
    assert.equal(store.listSubscriptions().length, 1);

    // 5. Routing config
    const routing = store.getRoutingConfig();
    assert.equal(routing.mode, 'rule');
  } finally {
    if (fs.existsSync(tempFile)) {
      fs.unlinkSync(tempFile);
    }
  }
});

test('RoutingManager correctly dispatches domain rules', () => {
  const tempFile = path.join(os.tmpdir(), `aih-test-proxy-pool-${Date.now()}-2.json`);
  const store = new ProxyNodeStore(tempFile);
  const router = new RoutingManager(store);

  try {
    store.setRoutingConfig({
      mode: 'rule',
      activeOutboundNodeId: 'node_default_proxy'
    });

    const resOpenAI = router.resolveOutbound('api.openai.com');
    assert.equal(resOpenAI.outbound, 'proxy');
    assert.equal(resOpenAI.nodeId, 'node_default_proxy');

    const resCN = router.resolveOutbound('www.baidu.com');
    assert.equal(resCN.outbound, 'direct');
    assert.equal(resCN.nodeId, null);
  } finally {
    if (fs.existsSync(tempFile)) {
      fs.unlinkSync(tempFile);
    }
  }
});

test('ProxyPoolService rejects a subscription URL instead of importing it as an HTTP proxy node', async () => {
  const store = createInjectedStore();
  const service = createInjectedService(store, createUnavailableCoreRuntime());

  const result = await service.importNodes('https://example.com/sub');

  assert.equal(result.ok, false);
  assert.equal(result.error, 'subscription_url_requires_subscription_flow');
  assert.equal(store.bulkUpsertCalls, 0);
  assert.equal(store.listNodes().length, 0);
});

test('ProxyPoolService reports an unavailable Mihomo data plane explicitly', () => {
  const store = createInjectedStore();
  const service = createInjectedService(store, createUnavailableCoreRuntime());

  const status = service.getCoreStatus();

  assert.equal(status.engine, 'mihomo');
  assert.equal(status.installed, false);
  assert.equal(status.running, false);
  assert.equal(status.dataPlaneReady, false);
});

test('ProxyPoolService closes a running Mihomo runtime without touching the system proxy', async () => {
  const store = createInjectedStore();
  let stopCalls = 0;
  const coreRuntime = {
    getStatus() {
      return {
        engine: 'mihomo',
        installed: true,
        running: true,
        dataPlaneReady: true,
        mixedProxyUrl: 'http://127.0.0.1:10800'
      };
    },
    async stop() {
      stopCalls += 1;
      return {
        ok: true,
        applied: true,
        action: 'stop',
        core: {
          engine: 'mihomo',
          installed: true,
          running: false,
          dataPlaneReady: false,
          mixedProxyUrl: null
        },
        warnings: []
      };
    }
  };
  const service = createInjectedService(store, coreRuntime);

  const result = await service.close();

  assert.equal(stopCalls, 1);
  assert.equal(result.ok, true);
  assert.equal(result.applied, true);
  assert.equal(result.action, 'stop');
});

test('closeDefaultProxyPoolService is idempotent when the web UI never created the pool', async () => {
  const result = await closeDefaultProxyPoolService();

  assert.deepEqual(result, {
    ok: true,
    applied: true,
    action: 'stop',
    skipped: true
  });
});

test('ProxyPoolService serializes TUN config application behind an existing mutation', async () => {
  const store = createInjectedStore();
  let tun = { enabled: false, stack: 'mixed' };
  store.getNetworkConfig = () => ({ tun: { ...tun } });
  store.setNetworkConfig = (update) => {
    tun = { ...tun, ...(update.tun || {}) };
    return { tun: { ...tun } };
  };
  let reloadCalls = 0;
  const coreRuntime = {
    getStatus() {
      return { engine: 'mihomo', installed: true, running: true, dataPlaneReady: true };
    },
    async reload() {
      reloadCalls += 1;
      return { ok: true, applied: true, warnings: [] };
    }
  };
  const service = createInjectedService(store, coreRuntime);
  const held = createDeferred();
  service._enqueueMutation(async () => {
    await held.promise;
  });
  const plan = service.planTunIntegration({
    action: 'enable',
    tun: { stack: 'gvisor' },
    network: { tun: { state: 'inactive', owner: null }, conflicts: [] }
  });
  const applyPromise = service.applyTunIntegration(plan.plan, {
    confirmed: true,
    expectedSnapshotHash: plan.plan.snapshotHash,
    network: { tun: { state: 'inactive', owner: null }, conflicts: [] }
  });

  await Promise.resolve();
  assert.equal(tun.enabled, false);
  held.resolve();
  const result = await applyPromise;

  assert.equal(result.ok, true);
  assert.equal(tun.enabled, true);
  assert.equal(reloadCalls, 1);
});

test('ProxyPoolService rejects a TUN plan when persisted intent changed after planning', async () => {
  const store = createInjectedStore();
  let tun = { enabled: false, stack: 'mixed' };
  store.getNetworkConfig = () => ({ tun: { ...tun } });
  store.setNetworkConfig = (update) => {
    tun = { ...tun, ...(update.tun || {}) };
    return { tun: { ...tun } };
  };
  const service = createInjectedService(store, {
    getStatus() {
      return { engine: 'mihomo', installed: true, running: false, dataPlaneReady: false };
    }
  });
  const plan = service.planTunIntegration({
    action: 'enable',
    tun: { stack: 'gvisor' },
    network: { tun: { state: 'inactive', owner: null }, conflicts: [] }
  });
  store.setNetworkConfig({ tun: { stack: 'system' } });

  const result = await service.applyTunIntegration(plan.plan, {
    confirmed: true,
    expectedSnapshotHash: plan.plan.snapshotHash,
    network: { tun: { state: 'inactive', owner: null }, conflicts: [] }
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'tun_snapshot_changed');
  assert.equal(tun.stack, 'system');
});

test('ProxyPoolService refuses a dedicated listener when the Mihomo core is unavailable without retaining a mapping', async () => {
  const node = {
    id: 'node_ss_unavailable',
    name: 'Unavailable SS node',
    protocol: 'shadowsocks',
    server: '198.51.100.10',
    port: 8388,
    cipher: 'aes-256-gcm',
    password: 'secret'
  };
  const store = createInjectedStore([node]);
  const service = createInjectedService(store, createUnavailableCoreRuntime());

  const result = await service.toggleDedicatedPort(node.id, true, 10801);

  assert.equal(result.ok, false);
  assert.equal(result.error, 'proxy_core_unavailable');
  assert.equal(store.dedicatedMappingCount, 0);
});

test('ProxyPoolService refuses node health checks when the Mihomo data plane is unavailable', async () => {
  const node = {
    id: 'node_vless_unavailable',
    name: 'Unavailable VLESS node',
    protocol: 'vless',
    server: '127.0.0.1',
    port: 9,
    uuid: 'e39b9866-51cf-4a41-b0e6-7ec9cf7bcfca'
  };
  const store = createInjectedStore([node]);
  const coreRuntime = createUnavailableCoreRuntime();
  const service = createInjectedService(store, coreRuntime);

  const result = await service.pingNode(node.id);

  assert.equal(result.ok, false);
  assert.equal(result.error, 'proxy_core_unavailable');
  assert.equal(coreRuntime.pingCalls, 0);
  assert.deepEqual(store.latencyUpdates, []);
});

test('ProxyPoolService starts Mihomo with the current nodes, routing policy, and dedicated listener mappings', async () => {
  const node = {
    id: 'node_ss_ready',
    name: 'Ready SS node',
    protocol: 'shadowsocks',
    server: '198.51.100.30',
    port: 8388,
    cipher: 'aes-256-gcm',
    password: 'secret'
  };
  const store = createInjectedStore([node]);
  store.setRoutingConfig({
    mode: 'global',
    activeOutboundNodeId: node.id,
    rules: []
  });
  store.assignDedicatedPort(node.id, 10801);

  let appliedState = null;
  const readyStatus = {
    engine: 'mihomo',
    installed: true,
    running: true,
    dataPlaneReady: true,
    binaryName: 'mihomo',
    version: 'Mihomo Meta v1.19.0',
    mixedProxyUrl: 'http://127.0.0.1:10800',
    activeListeners: [{ nodeId: node.id, port: 10801 }],
    lastError: null
  };
  const coreRuntime = {
    getStatus() {
      return readyStatus;
    },
    async start(state) {
      appliedState = state;
      return {
        ok: true,
        action: 'start',
        applied: true,
        core: readyStatus,
        warnings: []
      };
    }
  };
  const service = createInjectedService(store, coreRuntime);

  const result = await service.startCore();

  assert.equal(result.ok, true);
  assert.deepEqual(appliedState.nodes, [node]);
  assert.deepEqual(appliedState.routing, {
    mode: 'global',
    activeOutboundNodeId: node.id,
    rules: []
  });
  assert.equal(appliedState.dedicatedPorts.mappings[node.id], 10801);
});

test('ProxyPoolService plans system proxy changes from the ready mixed endpoint and blocks external TUN takeover', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-proxy-network-service-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new ProxyNodeStore(path.join(directory, 'pool.json'));
  const core = {
    getStatus: () => ({
      engine: 'mihomo', installed: true, running: true, dataPlaneReady: true,
      mixedProxyUrl: 'http://127.0.0.1:10800', activeListeners: [], lastError: null
    }),
    async reload() { return { ok: true, applied: true, core: this.getStatus(), warnings: [] }; },
    async stop() { return { ok: true, applied: true, core: this.getStatus(), warnings: [] }; }
  };
  const service = new ProxyPoolService({ store, coreRuntime: core });
  const current = {
    web: { enabled: false, server: '', port: 0, bypass: [] },
    secureWeb: { enabled: false, server: '', port: 0, bypass: [] },
    socks: { enabled: false, server: '', port: 0, bypass: [] },
    pac: { enabled: false, url: '' }
  };
  const network = {
    tun: { state: 'inactive', owner: null },
    systemProxy: { enabled: false },
    effectiveRoute: 'direct-unknown'
  };
  const plan = service.planNetworkIntegration({ action: 'enable', service: 'Wi-Fi', current, network }, { platform: 'darwin' });
  assert.equal(plan.ok, true);
  assert.equal(plan.plan.proxyUrl, 'http://127.0.0.1:10800');
  assert.match(plan.plan.planId, /^[a-f0-9]{64}$/);

  const applied = await service.applyNetworkIntegration(plan.plan, {
    confirmed: true,
    expectedSnapshotHash: plan.plan.snapshotHash,
    execCommand: () => ({ status: 0 })
  });
  assert.equal(applied.ok, true);
  assert.equal(applied.applied, true);

  const blocked = service.planNetworkIntegration({
    action: 'enable',
    service: 'Wi-Fi',
    current,
    network: { tun: { state: 'active', owner: 'clash-verge' } }
  }, { platform: 'darwin' });
  assert.deepEqual(blocked, { ok: false, error: 'external_tun_active' });
});

test('ProxyPoolService serializes system proxy mutations with core lifecycle changes', async () => {
  const service = createInjectedService(createInjectedStore(), createUnavailableCoreRuntime());
  const gate = createDeferred();
  service.mutationTail = gate.promise;
  const calls = [];
  const pending = service.applyNetworkIntegration({
    action: 'disable',
    snapshotHash: 'd'.repeat(64),
    operations: [{ key: 'disable', command: 'networksetup', args: ['-setwebproxystate', 'Wi-Fi', 'off'] }],
    rollbackOperations: []
  }, {
    confirmed: true,
    expectedSnapshotHash: 'd'.repeat(64),
    execCommand(command, args) {
      calls.push([command, args]);
      return { status: 0 };
    }
  });

  await Promise.resolve();
  assert.deepEqual(calls, []);
  gate.resolve();
  const result = await pending;
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [['networksetup', ['-setwebproxystate', 'Wi-Fi', 'off']]]);
});

test('ProxyPoolService applies a TUN intent only after snapshot confirmation and reloads a running core', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-proxy-tun-service-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new ProxyNodeStore(path.join(directory, 'pool.json'));
  const reloads = [];
  const core = {
    getStatus: () => ({ engine: 'mihomo', installed: true, running: true, dataPlaneReady: true, mixedProxyUrl: 'http://127.0.0.1:10800', activeListeners: [] }),
    async reload(state) { reloads.push(state.tun); return { ok: true, applied: true, core: this.getStatus(), warnings: [] }; },
    async stop() { return { ok: true, applied: true, core: this.getStatus(), warnings: [] }; }
  };
  const service = new ProxyPoolService({ store, coreRuntime: core });
  const plan = service.planTunIntegration({ action: 'enable', tun: { stack: 'gvisor' }, network: { tun: { state: 'inactive' } } });
  assert.equal(plan.ok, true);
  const missingConfirmation = await service.applyTunIntegration(plan.plan, { expectedSnapshotHash: plan.plan.snapshotHash });
  assert.deepEqual(missingConfirmation, { ok: false, error: 'confirmation_required' });
  const applied = await service.applyTunIntegration(plan.plan, {
    confirmed: true,
    expectedSnapshotHash: plan.plan.snapshotHash,
    network: { tun: { state: 'inactive' } }
  });
  assert.equal(applied.ok, true);
  assert.equal(applied.applied, true);
  assert.equal(store.getNetworkConfig().tun.enabled, true);
  assert.equal(reloads.length, 1);
  assert.equal(reloads[0].stack, 'gvisor');
  assert.equal(reloads[0].enabled, true);
});

test('ProxyPoolService restores a node and dedicated mapping when Mihomo rejects removal', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-proxy-delete-mapped-node-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new ProxyNodeStore(path.join(directory, 'pool.json'));
  const node = store.upsertNode({
    name: 'Delete guard',
    protocol: 'http',
    server: 'proxy.example.com',
    port: 8080
  });
  store.assignDedicatedPort(node.id, 10801);
  let reloadCount = 0;
  const coreRuntime = {
    getStatus() {
      return {
        engine: 'mihomo',
        installed: true,
        running: true,
        dataPlaneReady: true,
        activeListeners: [{ nodeId: node.id, port: 10801, listening: true }]
      };
    },
    async reload() {
      reloadCount += 1;
      return reloadCount === 1
        ? { ok: false, applied: false, error: 'proxy_core_reload_failed' }
        : { ok: true, applied: true, warnings: [] };
    }
  };
  const service = new ProxyPoolService({ store, coreRuntime });

  const result = await service.deleteNode(node.id);

  assert.equal(result.ok, false);
  assert.equal(result.error, 'proxy_core_reload_failed');
  assert.equal(reloadCount, 2);
  assert.equal(store.getNode(node.id)?.id, node.id);
  assert.equal(store.getDedicatedPortsConfig().mappings[node.id], 10801);
});

test('ProxyPoolService restores a subscription when Mihomo rejects its removal', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-proxy-delete-sub-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new ProxyNodeStore(path.join(directory, 'pool.json'));
  const subscription = store.upsertSubscription({
    name: 'guarded subscription',
    url: 'https://example.com/subscription'
  });
  const [node] = store.bulkUpsertNodes([{
    name: 'guarded node',
    protocol: 'http',
    server: 'proxy.example.com',
    port: 8080
  }], subscription.id);
  store.assignDedicatedPort(node.id, 10801);
  let reloadCount = 0;
  const coreRuntime = {
    getStatus() {
      return {
        engine: 'mihomo',
        installed: true,
        running: true,
        dataPlaneReady: true,
        activeListeners: [{ nodeId: node.id, port: 10801, listening: true }]
      };
    },
    async reload() {
      reloadCount += 1;
      return reloadCount === 1
        ? { ok: false, applied: false, error: 'proxy_core_reload_failed' }
        : { ok: true, applied: true, warnings: [] };
    }
  };
  const service = new ProxyPoolService({ store, coreRuntime });

  const result = await service.deleteSubscription(subscription.id);

  assert.equal(result.ok, false);
  assert.equal(result.error, 'proxy_core_reload_failed');
  assert.equal(reloadCount, 2);
  assert.equal(store.listSubscriptions().length, 1);
  assert.equal(store.listNodes().length, 1);
  assert.equal(store.getDedicatedPortsConfig().mappings[node.id], 10801);
});

test('ProxyPoolService restores a node when Mihomo rejects its removal', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-proxy-delete-node-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new ProxyNodeStore(path.join(directory, 'pool.json'));
  const node = store.upsertNode({
    name: 'guarded node',
    protocol: 'http',
    server: 'proxy.example.com',
    port: 8080
  });
  let reloadCount = 0;
  const coreRuntime = {
    getStatus() {
      return {
        engine: 'mihomo',
        installed: true,
        running: true,
        dataPlaneReady: true,
        activeListeners: []
      };
    },
    async reload() {
      reloadCount += 1;
      return reloadCount === 1
        ? { ok: false, applied: false, error: 'proxy_core_reload_failed' }
        : { ok: true, applied: true, warnings: [] };
    }
  };
  const service = new ProxyPoolService({ store, coreRuntime });

  const result = await service.deleteNode(node.id);

  assert.equal(result.ok, false);
  assert.equal(result.error, 'proxy_core_reload_failed');
  assert.equal(reloadCount, 2);
  assert.equal(store.getNode(node.id)?.id, node.id);
});

test('ProxyPoolService restores previous subscription nodes when Mihomo rejects a sync', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-proxy-sync-sub-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new ProxyNodeStore(path.join(directory, 'pool.json'));
  const subscription = store.upsertSubscription({
    name: 'guarded subscription',
    url: 'https://example.com/subscription'
  });
  const [oldNode] = store.bulkUpsertNodes([{
    name: 'old node',
    protocol: 'http',
    server: 'old.example.com',
    port: 8080
  }], subscription.id);
  store.assignDedicatedPort(oldNode.id, 10801);
  let reloadCount = 0;
  const coreRuntime = {
    getStatus() {
      return {
        engine: 'mihomo',
        installed: true,
        running: true,
        dataPlaneReady: true,
        activeListeners: [{ nodeId: oldNode.id, port: 10801, listening: true }]
      };
    },
    async reload() {
      reloadCount += 1;
      return reloadCount === 1
        ? { ok: false, applied: false, error: 'proxy_core_reload_failed' }
        : { ok: true, applied: true, warnings: [] };
    }
  };
  const service = new ProxyPoolService({
    store,
    coreRuntime,
    subscriptionFetcher: {
      async fetch() {
        return { content: 'http://new.example.com:8080#new-node', url: subscription.url };
      }
    }
  });

  const result = await service.syncSubscription(subscription.id);

  assert.equal(result.ok, false);
  assert.equal(result.error, 'proxy_core_reload_failed');
  assert.equal(reloadCount, 2);
  assert.deepEqual(store.listNodes().map((node) => node.id), [oldNode.id]);
  assert.equal(store.getDedicatedPortsConfig().mappings[oldNode.id], 10801);
  const persisted = JSON.parse(fs.readFileSync(path.join(directory, 'pool.json'), 'utf8'));
  assert.equal(Object.hasOwn(persisted.nodes[0], 'dedicatedPort'), false);
});

test('ProxyPoolService applies synchronized subscription nodes through Mihomo before reporting success', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-proxy-sync-apply-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new ProxyNodeStore(path.join(directory, 'pool.json'));
  const subscription = store.upsertSubscription({
    name: 'applied subscription',
    url: 'https://example.com/subscription'
  });
  const [oldNode] = store.bulkUpsertNodes([{
    name: 'old node',
    protocol: 'http',
    server: 'old.example.com',
    port: 8080
  }], subscription.id);
  store.assignDedicatedPort(oldNode.id, 10801);
  let reloadedState = null;
  const coreRuntime = {
    getStatus() {
      return {
        engine: 'mihomo',
        installed: true,
        running: true,
        dataPlaneReady: true,
        activeListeners: []
      };
    },
    async reload(state) {
      reloadedState = state;
      return { ok: true, applied: true, warnings: [] };
    }
  };
  const service = new ProxyPoolService({
    store,
    coreRuntime,
    subscriptionFetcher: {
      async fetch() {
        return { content: 'http://new.example.com:8080#new-node', url: subscription.url };
      }
    }
  });

  const result = await service.syncSubscription(subscription.id);

  assert.equal(result.ok, true);
  assert.equal(result.applied, true);
  assert.equal(result.count, 1);
  assert.equal(reloadedState.nodes.length, 1);
  assert.equal(reloadedState.nodes[0].server, 'new.example.com');
  assert.equal(store.listNodes()[0].server, 'new.example.com');
  assert.equal(store.getDedicatedPortsConfig().mappings[oldNode.id], undefined);
});

test('ProxyPoolService serializes a node upsert behind a failing delete transaction', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-proxy-mutation-queue-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new ProxyNodeStore(path.join(directory, 'pool.json'));
  const oldNode = store.upsertNode({
    name: 'old node',
    protocol: 'http',
    server: 'old.example.com',
    port: 8080
  });
  const firstReload = createDeferred();
  let reloadCount = 0;
  const coreRuntime = {
    getStatus() {
      return {
        engine: 'mihomo',
        installed: true,
        running: true,
        dataPlaneReady: true,
        activeListeners: []
      };
    },
    async reload() {
      reloadCount += 1;
      if (reloadCount === 1) {
        await firstReload.promise;
        return { ok: false, applied: false, error: 'proxy_core_reload_failed' };
      }
      return { ok: true, applied: true, warnings: [] };
    }
  };
  const service = new ProxyPoolService({ store, coreRuntime });

  const deletion = service.deleteNode(oldNode.id);
  await new Promise((resolve) => setImmediate(resolve));
  const upsert = service.upsertNode({
    name: 'new node',
    protocol: 'http',
    server: 'new.example.com',
    port: 8080
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(store.listNodes().some((node) => node.server === 'new.example.com'), false);
  firstReload.resolve();
  const [deleteResult, upsertResult] = await Promise.all([deletion, upsert]);

  assert.equal(deleteResult.ok, false);
  assert.equal(upsertResult.ok, true);
  assert.deepEqual(
    store.listNodes().map((node) => node.server).sort(),
    ['new.example.com', 'old.example.com']
  );
});

test('ProxyPoolService rolls back a delete when reload reports applied false', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-proxy-delete-unapplied-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new ProxyNodeStore(path.join(directory, 'pool.json'));
  const node = store.upsertNode({
    name: 'unapplied delete',
    protocol: 'http',
    server: 'proxy.example.com',
    port: 8080
  });
  let reloadCount = 0;
  const coreRuntime = {
    getStatus() {
      return { engine: 'mihomo', installed: true, running: true, dataPlaneReady: true, activeListeners: [] };
    },
    async reload() {
      reloadCount += 1;
      return reloadCount === 1
        ? { ok: true, applied: false, error: 'proxy_core_readiness_failed', warnings: [] }
        : { ok: true, applied: true, warnings: [] };
    }
  };
  const service = new ProxyPoolService({ store, coreRuntime });

  const result = await service.deleteNode(node.id);

  assert.equal(result.ok, false);
  assert.equal(result.applied, false);
  assert.equal(result.error, 'proxy_core_readiness_failed');
  assert.equal(store.getNode(node.id)?.id, node.id);
  assert.equal(reloadCount, 2);
});

test('ProxyPoolService rolls back a delete when Mihomo reports a routing fallback warning', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-proxy-delete-routing-warning-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new ProxyNodeStore(path.join(directory, 'pool.json'));
  const node = store.upsertNode({
    name: 'active outbound',
    protocol: 'http',
    server: 'proxy.example.com',
    port: 8080
  });
  store.setRoutingConfig({ mode: 'global', activeOutboundNodeId: node.id, rules: [] });
  let reloadCount = 0;
  const coreRuntime = {
    getStatus() {
      return { engine: 'mihomo', installed: true, running: true, dataPlaneReady: true, activeListeners: [] };
    },
    async reload() {
      reloadCount += 1;
      return reloadCount === 1
        ? { ok: true, applied: true, warnings: ['routing_active_outbound_missing'] }
        : { ok: true, applied: true, warnings: [] };
    }
  };
  const service = new ProxyPoolService({ store, coreRuntime });

  const result = await service.deleteNode(node.id);

  assert.equal(result.ok, false);
  assert.equal(result.applied, false);
  assert.equal(result.error, 'routing_not_fully_applied');
  assert.equal(store.getNode(node.id)?.id, node.id);
  assert.equal(reloadCount, 2);
});

test('ProxyPoolService reports a rollback failure instead of throwing or claiming the node was restored', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-proxy-delete-rollback-failure-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new ProxyNodeStore(path.join(directory, 'pool.json'));
  const node = store.upsertNode({
    name: 'rollback failure',
    protocol: 'http',
    server: 'proxy.example.com',
    port: 8080
  });
  store.restoreNodeSnapshot = () => {
    throw new Error('disk unavailable');
  };
  const coreRuntime = {
    getStatus() {
      return { engine: 'mihomo', installed: true, running: true, dataPlaneReady: true, activeListeners: [] };
    },
    async reload() {
      return { ok: false, applied: false, error: 'proxy_core_reload_failed' };
    }
  };
  const service = new ProxyPoolService({ store, coreRuntime });

  const result = await service.deleteNode(node.id);

  assert.equal(result.ok, false);
  assert.equal(result.applied, false);
  assert.equal(result.error, 'node_rollback_failed');
  assert.match(result.message, /disk unavailable/);
});

test('ProxyPoolService discards fetched nodes when the subscription changes before apply', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-proxy-sync-stale-url-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new ProxyNodeStore(path.join(directory, 'pool.json'));
  const subscription = store.upsertSubscription({
    name: 'changing subscription',
    url: 'https://old.example.com/subscription'
  });
  const response = createDeferred();
  const coreRuntime = {
    getStatus() {
      return { engine: 'mihomo', installed: true, running: false, dataPlaneReady: false, activeListeners: [] };
    }
  };
  const service = new ProxyPoolService({
    store,
    coreRuntime,
    subscriptionFetcher: {
      async fetch() {
        return response.promise;
      }
    }
  });

  const syncing = service.syncSubscription(subscription.id);
  await service.upsertSubscription({
    ...subscription,
    url: 'https://new.example.com/subscription'
  });
  response.resolve({
    content: 'http://stale.example.com:8080#stale-node',
    url: subscription.url
  });
  const result = await syncing;

  assert.equal(result.ok, false);
  assert.equal(result.applied, false);
  assert.equal(result.error, 'subscription_changed_during_sync');
  assert.equal(store.listNodes().length, 0);
  assert.equal(store.listSubscriptions()[0].url, 'https://new.example.com/subscription');
});
