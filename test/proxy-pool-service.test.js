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
    'juicity://uuid:pass@198.51.100.2:443#juicity',
    'wireguard://key@198.51.100.2:51820#wg-without-peer-key',
    'vless://e39b9866-51cf-4a41-b0e6-7ec9cf7bcfca@198.51.100.3:443?security=reality#reality-without-key'
  ].join('\n'));

  const result = await service.syncSubscription(subscription.id);

  assert.equal(result.ok, true);
  assert.equal(result.count, 1);
  const reasons = result.skippedNodes.map((item) => item.reason);
  assert.ok(reasons.includes('unsupported_proxy_protocol_juicity'), JSON.stringify(reasons));
  assert.ok(reasons.includes('invalid_proxy_link_wireguard'), JSON.stringify(reasons));
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

// 节点快照缓存（2026-10-22）：只加速解析，绝不改变语义 —— 调用方改拷贝不能污染库，
// 本进程写入与外部改文件都必须立刻可见（这是「缓存」不是「TTL 缓存」）。
test('listNodes caches parsing but still hands out isolated copies that follow every write', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-node-cache-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let reads = 0;
  const countingFs = new Proxy(fs, {
    get(target, prop) {
      if (prop !== 'readFileSync') return target[prop];
      return (...args) => { reads += 1; return target.readFileSync(...args); };
    }
  });
  const store = new ProxyNodeStore({ filePath: path.join(dir, 'pool.json'), fs: countingFs });
  const sub = store.upsertSubscription({ name: '机场', url: 'https://a.example/sub' });
  store.replaceSubscriptionNodes(sub.id, [
    { protocol: 'vless', server: 'a.example.com', port: 443, uuid: 'u1', name: '甲' },
    { protocol: 'vless', server: 'b.example.com', port: 443, uuid: 'u2', name: '乙' }
  ]);

  reads = 0;
  const first = store.listNodes();
  store.listNodes();
  store.listNodes();
  assert.equal(reads, 1, '重复读取只解析一次（缓存生效）');

  // 隔离性：改拷贝不影响库，也不影响下一次读取（缓存复用了内部快照，但对外必须发拷贝）。
  first[0].latencyMs = 12345;
  first.pop();
  const second = store.listNodes();
  assert.equal(second.length, 2, '调用方 pop 不影响后续读取');
  assert.notEqual(second[0].latencyMs, 12345, '调用方改拷贝不污染库');
  assert.notEqual(second, first, '每次都是新数组');

  // 本进程写入立刻可见（同一次写入 mtime 可能不变，所以不能只靠 mtime）。
  store.recordNodeLatency({ [require('../lib/runtime/node-identity').nodeKeyOf(second[0])]: { ms: 777 } });
  assert.equal(store.listNodes()[0].latencyMs, 777, '写入后立即读到新值');

  // 外部改文件也立刻可见。
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'pool.json'), 'utf8'));
  raw.nodes[0].latencyMs = 999;
  fs.writeFileSync(path.join(dir, 'pool.json'), JSON.stringify(raw, null, 2));
  assert.equal(store.listNodes()[0].latencyMs, 999, '外部写入后立即读到新值');

  // 带过滤的调用返回新数组（不共享缓存数组）。
  assert.notEqual(store.listNodes({ protocol: 'vless' }), store.listNodes({ protocol: 'vless' }));
});
