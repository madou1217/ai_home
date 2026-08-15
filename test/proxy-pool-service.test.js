'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const { ProxyNodeStore } = require('../lib/cli/services/toolkit/proxy-pool/proxy-node-store');
const { ProxyPoolService } = require('../lib/cli/services/toolkit/proxy-pool/proxy-pool-service');
const { RoutingManager } = require('../lib/cli/services/toolkit/proxy-pool/routing-manager');

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
