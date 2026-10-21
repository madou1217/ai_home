'use strict';

// 订阅源的两种来源：远程地址（默认以 clash.meta 拉取，可按源覆盖 User-Agent）与本地内容
// （粘贴的节点，保存即解析、不联网）。用真实的节点库 + 订阅源端口 + 聚合服务串起来测。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const test = require('node:test');

const { ProxyNodeStore } = require('../lib/cli/services/toolkit/proxy-pool/proxy-node-store');
const { ProxyPoolService } = require('../lib/cli/services/toolkit/proxy-pool/proxy-pool-service');
const { SubscriptionFetcher } = require('../lib/cli/services/toolkit/proxy-pool/subscription-fetcher');
const { SubscriptionAggregatorStore } = require('../lib/cli/services/toolkit/subscription-aggregator/profile-store');
const { SubscriptionAggregatorService } = require('../lib/cli/services/toolkit/subscription-aggregator/aggregator-service');
const { createProxyPoolSourcePort } = require('../lib/cli/services/toolkit/subscription-aggregator/proxy-pool-source-port');

const TROJAN = 'trojan://p@tj.example:443#tj';
const VLESS = 'vless://11111111-2222-3333-4444-555555555555@vl.example:443?security=tls&sni=vl.example#vl';

function setup(t, { fetch } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-aggregator-sources-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fetches = [];
  const nodeStore = new ProxyNodeStore(path.join(dir, 'pool.json'));
  const pool = new ProxyPoolService({
    store: nodeStore,
    subscriptionFetcher: {
      async fetch(url, options = {}) {
        fetches.push([url, options.userAgent]);
        return fetch ? fetch(url, options) : { content: TROJAN, url };
      }
    }
  });
  // 节点库用真实时间记 lastSyncedAt，聚合服务的时钟从真实时间起步再快进。
  let now = Date.now();
  const service = new SubscriptionAggregatorService({
    sources: createProxyPoolSourcePort(pool),
    store: new SubscriptionAggregatorStore({ filePath: path.join(dir, 'aggregator.json'), now: () => now }),
    now: () => now
  });
  return { service, nodeStore, fetches, advance: (ms) => { now += ms; } };
}

/** 等某个异步同步任务结束（远程订阅保存后的拉取在后台进行）。 */
async function waitForJob(service, jobId, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = service.syncRunner.getJob(jobId);
    if (job && job.finishedAt) return job;
    if (Date.now() > deadline) throw new Error(`sync job ${jobId} did not finish`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('local sources parse pasted content without fetching and re-sync only when it changes', async (t) => {
  const { service, nodeStore, fetches } = setup(t);
  const created = await service.saveSource({ name: '自建', kind: 'local', content: TROJAN });
  assert.equal(created.ok, true);
  assert.deepEqual(created.sync && [created.sync.ok, created.sync.count], [true, 1]);
  assert.deepEqual(
    [created.subscription.kind, created.subscription.url, created.subscription.content],
    ['local', null, TROJAN]
  );
  const id = created.subscription.id;
  assert.match(id, /^sub_[0-9a-f]{12}$/);

  const [source] = service.getOverview().sources;
  assert.deepEqual([source.kind, source.nodeCount, source.userInfo], ['local', 1, null]);

  // 只改名不重新解析；改了内容立即重新解析。
  assert.equal((await service.saveSource({ id, name: '改名', kind: 'local', content: TROJAN })).sync, undefined);
  const changed = await service.saveSource({ id, name: '改名', kind: 'local', content: `${TROJAN}\n${VLESS}` });
  assert.equal(changed.sync.count, 2);
  assert.deepEqual(nodeStore.listNodes().map((node) => node.name).sort(), ['tj', 'vl']);
  assert.deepEqual(fetches, []);

  // 同名的两份本地内容各自独立。
  const twin = await service.saveSource({ name: '改名', kind: 'local', content: VLESS });
  assert.notEqual(twin.subscription.id, id);

  await assert.rejects(service.saveSource({ name: '空', kind: 'local', content: '  \n' }), { code: 'invalid_subscription_content' });
  await assert.rejects(
    service.saveSource({ name: '太大', kind: 'local', content: 'x'.repeat(2 * 1024 * 1024 + 1) }),
    { code: 'subscription_content_too_large' }
  );
});

test('remote sources fetch with the per-source User-Agent and re-sync when it changes', async (t) => {
  const { service, fetches } = setup(t, {
    fetch: (url) => ({ content: TROJAN, url, userInfo: { upload: 1, download: 2, total: 10 } })
  });
  const created = await service.saveSource({ name: '机场', url: 'https://a.example/sub' });
  const id = created.subscription.id;
  assert.equal(created.subscription.userAgent, null);
  // 远程订阅保存后不阻塞：返回待完成的任务，拉取在后台进行。
  assert.deepEqual(created.sync, { ok: true, pending: true });
  await waitForJob(service, created.job.id);
  const withUa = await service.saveSource({ id, name: '机场', url: 'https://a.example/sub', userAgent: 'v2rayN/6.42' });
  assert.equal(withUa.sync.ok, true);
  assert.equal((await waitForJob(service, withUa.job.id)).status, 'succeeded');
  assert.deepEqual(fetches, [['https://a.example/sub', undefined], ['https://a.example/sub', 'v2rayN/6.42']]);
  await assert.rejects(
    service.saveSource({ id, name: '机场', url: 'https://a.example/sub', userAgent: 'bad\r\nX-Injected: 1' }),
    { code: 'invalid_subscription_user_agent' }
  );

  // 远程改成本地：地址、User-Agent 与远程同步得到的流量信息一并去掉。
  const local = await service.saveSource({ id, name: '机场', kind: 'local', content: VLESS });
  assert.equal(local.sync.ok, true);
  const [source] = service.getOverview().sources;
  assert.deepEqual([source.kind, source.url, source.userInfo, source.userAgent], ['local', null, null, undefined]);
  // 再改回远程：本地内容不残留。
  await service.saveSource({ id, name: '机场', kind: 'remote', url: 'https://b.example/sub' });
  const [remote] = service.getOverview().sources;
  assert.deepEqual([remote.kind, remote.url, remote.content], ['remote', 'https://b.example/sub', undefined]);
});

test('client pulls refresh stale remote sources but never re-parse local ones', async (t) => {
  const { service, advance, fetches } = setup(t);
  await service.saveSource({ name: '机场', url: 'https://a.example/sub' });
  await service.saveSource({ name: '自建', kind: 'local', content: VLESS });
  const profile = service.saveProfile({ name: '聚合', refreshHours: 1 }).profile;
  advance(2 * 60 * 60 * 1000);
  const response = await service.serveSubscription(profile.token, { target: 'base64' });
  assert.equal(response.status, 200);
  assert.deepEqual(fetches.map(([url]) => url), ['https://a.example/sub', 'https://a.example/sub']);
  assert.equal(Buffer.from(response.body, 'base64').toString('utf8').split('\n').length, 2);
});

test('the overview catalog lists every protocol and the default User-Agent', (t) => {
  const { service } = setup(t);
  const { catalog } = service.getOverview();
  assert.equal(catalog.defaultUserAgent, 'clash.meta');
  assert.ok(['shadowsocksr', 'tuic', 'wireguard', 'snell', 'https'].every((protocol) => catalog.protocols.includes(protocol)));
  assert.ok(catalog.formats.some((format) => format.id === 'quantumult-x'));
});

test('SubscriptionFetcher sends clash.meta unless the source overrides the User-Agent', async () => {
  const userAgents = [];
  const fetcher = new SubscriptionFetcher({
    resolveHost: async () => ['93.184.216.34'],
    dispatcherFactory: () => ({ async close() {} }),
    requestImpl: async (_url, options) => {
      userAgents.push(options.headers['User-Agent']);
      return { statusCode: 200, headers: {}, body: Readable.from(['ok']) };
    }
  });
  await fetcher.fetch('https://subscription.example/sub');
  await fetcher.fetch('https://subscription.example/sub', { userAgent: 'Shadowrocket/2070' });
  assert.deepEqual(userAgents, ['clash.meta', 'Shadowrocket/2070']);
});

test('previewing local content reports the nodes and skips without saving anything', (t) => {
  const { service, nodeStore } = setup(t);
  const result = service.previewSource({ content: `${TROJAN}\n${VLESS}\nfoo://bar@x:1#unknown\nvless://broken` });
  assert.equal(result.ok, true);
  assert.deepEqual(result.nodes.map((node) => [node.name, node.protocol, node.server, node.port]), [['tj', 'trojan', 'tj.example', 443], ['vl', 'vless', 'vl.example', 443]]);
  assert.deepEqual(result.skippedNodes.map((item) => item.reason), ['unsupported_proxy_protocol_foo', 'invalid_proxy_link_vless']);
  assert.equal(nodeStore.listSubscriptions().length, 0);
  assert.equal(nodeStore.listNodes().length, 0);
  assert.deepEqual(service.previewSource({ content: '   ' }), { ok: false, error: 'invalid_subscription_content' });
  assert.equal(service.previewSource({ content: 'x'.repeat(2 * 1024 * 1024 + 1) }).error, 'subscription_content_too_large');
});
