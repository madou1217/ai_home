'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const { ProxyNodeStore } = require('../lib/cli/services/toolkit/proxy-pool/proxy-node-store');
const { ProxyPoolService } = require('../lib/cli/services/toolkit/proxy-pool/proxy-pool-service');

const SS_URI = 'ss://YWVzLTI1Ni1nY206cGFzc3dvcmRAMTIz@198.51.100.1:8388#storage-only';

function createStore(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-proxy-pool-service-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return new ProxyNodeStore(path.join(directory, 'pool.json'));
}

function createDeferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function serviceWithContent(t, content) {
  const store = createStore(t);
  const subscription = store.upsertSubscription({ name: 'airport', url: 'https://sub.example.com/link' });
  const service = new ProxyPoolService({
    store,
    subscriptionFetcher: { async fetch() { return { content, url: 'https://sub.example.com/link' }; } }
  });
  return { store, subscription, service };
}

test('ProxyPoolService syncs URI, Base64 and Clash YAML subscription content into the node store', async (t) => {
  const cases = [
    ['URI', SS_URI],
    ['Base64', Buffer.from(SS_URI).toString('base64')],
    ['YAML', [
      'proxies:',
      '  - name: storage-only-yaml',
      '    type: http',
      '    server: proxy.example.com',
      '    port: 8080'
    ].join('\n')]
  ];
  for (const [format, content] of cases) {
    await t.test(format, async (subtest) => {
      const { store, subscription, service } = serviceWithContent(subtest, content);

      const result = await service.syncSubscription(subscription.id);

      assert.equal(result.ok, true);
      assert.equal(result.applied, true);
      assert.equal(result.count, 1);
      assert.equal(store.listNodes().length, 1);
    });
  }
});

test('ProxyPoolService reports unsupported schemes and nodes clients cannot use as skipped', async (t) => {
  const { service, subscription } = serviceWithContent(t, [
    SS_URI,
    'wireguard://key@198.51.100.2:51820#wg',
    'vless://e39b9866-51cf-4a41-b0e6-7ec9cf7bcfca@198.51.100.3:443?security=reality#reality-without-key'
  ].join('\n'));

  const result = await service.syncSubscription(subscription.id);

  assert.equal(result.ok, true);
  assert.equal(result.count, 1);
  const reasons = result.skippedNodes.map((item) => item.reason);
  assert.ok(reasons.includes('unsupported_proxy_protocol_wireguard'));
  assert.ok(reasons.includes('missing_required_proxy_field_publicKey'), JSON.stringify(reasons));
});

test('ProxyPoolService syncs a subscription into the store with its source URL and traffic info', async (t) => {
  const store = createStore(t);
  const subscription = store.upsertSubscription({ name: 'airport', url: 'https://sub.example.com/link' });
  const service = new ProxyPoolService({
    store,
    subscriptionFetcher: {
      async fetch() {
        return { content: SS_URI, url: 'https://cdn.example.com/link', userInfo: { upload: 1, download: 2, total: 10 } };
      }
    }
  });

  const result = await service.syncSubscription(subscription.id);

  assert.equal(result.ok, true);
  assert.equal(result.applied, true);
  assert.equal(result.count, 1);
  const stored = store.listSubscriptions()[0];
  assert.equal(stored.nodeCount, 1);
  assert.equal(stored.sourceUrl, 'https://cdn.example.com/link');
  assert.deepEqual(stored.userInfo, { upload: 1, download: 2, total: 10 });
  assert.equal(store.listNodes()[0].subscriptionId, subscription.id);
});

test('ProxyPoolService surfaces fetch failures without touching stored nodes', async (t) => {
  const store = createStore(t);
  const subscription = store.upsertSubscription({ name: 'airport', url: 'https://sub.example.com/link' });
  const service = new ProxyPoolService({
    store,
    subscriptionFetcher: {
      async fetch() {
        const error = new Error('blocked');
        error.code = 'subscription_url_blocked';
        throw error;
      }
    }
  });

  const result = await service.syncSubscription(subscription.id);

  assert.deepEqual(
    { ok: result.ok, applied: result.applied, error: result.error },
    { ok: false, applied: false, error: 'subscription_url_blocked' }
  );
  assert.equal((await service.syncSubscription('missing')).error, 'subscription_not_found');
});

test('ProxyPoolService discards fetched nodes when the subscription changes before apply', async (t) => {
  const store = createStore(t);
  const subscription = store.upsertSubscription({
    name: 'changing subscription',
    url: 'https://old.example.com/subscription'
  });
  const response = createDeferred();
  const service = new ProxyPoolService({
    store,
    subscriptionFetcher: {
      async fetch() {
        return response.promise;
      }
    }
  });

  const syncing = service.syncSubscription(subscription.id);
  await service.upsertSubscription({ ...subscription, url: 'https://new.example.com/subscription' });
  response.resolve({ content: 'http://stale.example.com:8080#stale-node', url: subscription.url });
  const result = await syncing;

  assert.equal(result.ok, false);
  assert.equal(result.applied, false);
  assert.equal(result.error, 'subscription_changed_during_sync');
  assert.equal(store.listNodes().length, 0);
  assert.equal(store.listSubscriptions()[0].url, 'https://new.example.com/subscription');
});

test('ProxyPoolService deletes a subscription together with its nodes', async (t) => {
  const { store, subscription, service } = serviceWithContent(t, SS_URI);
  await service.syncSubscription(subscription.id);
  const other = store.upsertSubscription({ name: 'other', url: 'https://other.example.com/link' });
  store.replaceSubscriptionNodes(other.id, [{
    name: 'kept', protocol: 'http', server: 'kept.example.com', port: 8080
  }]);

  const removed = await service.deleteSubscription(subscription.id);

  assert.deepEqual(removed, { ok: true, applied: true, removedNodeCount: 1 });
  assert.deepEqual(store.listNodes().map((node) => node.name), ['kept']);
  assert.equal((await service.deleteSubscription(subscription.id)).error, 'subscription_not_found');
});
