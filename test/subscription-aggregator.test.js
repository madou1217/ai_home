'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');

const { normalizeProfile } = require('../lib/cli/services/toolkit/subscription-aggregator/profile-schema');
const { SubscriptionAggregatorStore } = require('../lib/cli/services/toolkit/subscription-aggregator/profile-store');
const { detectRegion, selectAggregatedNodes } = require('../lib/cli/services/toolkit/subscription-aggregator/node-selection');
const { buildAggregationPlan } = require('../lib/cli/services/toolkit/subscription-aggregator/aggregation-plan');
const { detectRendererByUserAgent, getRenderer } = require('../lib/cli/services/toolkit/subscription-aggregator/renderers');
const { SubscriptionAggregatorService } = require('../lib/cli/services/toolkit/subscription-aggregator/aggregator-service');
const {
  aggregateSubscriptionUserInfo,
  formatSubscriptionUserInfo,
  parseSubscriptionUserInfo
} = require('../lib/cli/services/toolkit/proxy-pool/subscription-userinfo');
const { SubscriptionFetcher } = require('../lib/cli/services/toolkit/proxy-pool/subscription-fetcher');

function ssNode(id, name, subscriptionId, extra = {}) {
  return {
    id,
    name,
    protocol: 'shadowsocks',
    server: `${id}.example.com`,
    port: 8388,
    cipher: 'aes-128-gcm',
    password: `pw-${id}`,
    subscriptionId,
    ...extra
  };
}

const SOURCES = [
  { id: 'sub_a', name: '机场A', url: 'https://a.example/sub', nodeCount: 3, lastSyncedAt: 1000, userInfo: { upload: 1, download: 2, total: 100, expire: 2000 } },
  { id: 'sub_b', name: '机场B', url: 'https://b.example/sub', nodeCount: 2, lastSyncedAt: 1000, userInfo: { upload: 3, download: 4, total: 50, expire: 1500 } }
];

const NODES = [
  ssNode('a1', '🇭🇰 香港 01', 'sub_a'),
  ssNode('a2', '美国 US 02', 'sub_a'),
  ssNode('a3', '剩余流量：100 GB', 'sub_a'),
  ssNode('b1', '🇭🇰 香港 01', 'sub_b'),
  ssNode('b2', 'Japan Tokyo', 'sub_b'),
  ssNode('m1', 'manual node', null)
];

function makeProfile(input = {}) {
  return normalizeProfile({ name: '测试聚合', ...input }, { id: 'agg_1', token: 'tok_'.padEnd(43, 'x'), createdAt: 1 }, 1);
}

function createSourcePort(overrides = {}) {
  const calls = [];
  const port = {
    calls,
    sources: overrides.sources || SOURCES.map((source) => ({ ...source })),
    nodes: overrides.nodes || NODES,
    listSources() { return port.sources.map((source) => ({ ...source })); },
    listNodes() { return port.nodes; },
    async saveSource(input) {
      calls.push(['save', input]);
      return { ok: true, subscription: { id: input.id || 'sub_new', name: input.name, url: input.url } };
    },
    async deleteSource(id) {
      calls.push(['delete', id]);
      return { ok: true };
    },
    syncSource: overrides.syncSource || (async (id) => {
      calls.push(['sync', id]);
      return { ok: true, count: 1 };
    })
  };
  return port;
}

function createService(port, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-aggregator-'));
  // 订阅源 lastSyncedAt=1000，离"现在"已过去 10 小时，refreshHours=1 时视为过期。
  const now = () => 10 * 60 * 60 * 1000;
  const store = new SubscriptionAggregatorStore({ filePath: path.join(dir, 'aggregator.json'), now });
  return { dir, store, service: new SubscriptionAggregatorService({ sources: port, store, now, ...extra }) };
}

test('normalizeProfile fills defaults and keeps catalog preset order', () => {
  const profile = makeProfile();
  assert.equal(profile.sources.all, true);
  assert.equal(profile.dedupe, true);
  assert.match(profile.filter.exclude, /剩余/);
  assert.equal(profile.refreshHours, 12);
  assert.deepEqual(profile.rules.presets.map((preset) => preset.id).slice(0, 3), ['ads', 'ai', 'github']);
  assert.equal(profile.rules.presets.find((preset) => preset.id === 'ads').enabled, false);
  assert.equal(profile.rules.presets.find((preset) => preset.id === 'cn').policy, 'direct');
  assert.equal(profile.token, 'tok_'.padEnd(43, 'x'));
});

test('normalizeProfile rejects invalid regex, policies and rule values', () => {
  assert.throws(() => makeProfile({ filter: { include: '(' } }), { code: 'invalid_aggregator_pattern' });
  assert.throws(() => makeProfile({ rules: { finalPolicy: 'region:mars' } }), { code: 'invalid_aggregator_policy' });
  assert.throws(() => makeProfile({ rules: { custom: [{ type: 'DOMAIN', value: 'a,b', policy: 'proxy' }] } }), { code: 'invalid_aggregator_rule' });
  assert.throws(() => makeProfile({ rules: { custom: [{ type: 'IP-CIDR', value: '10.0.0.0/40', policy: 'proxy' }] } }), { code: 'invalid_aggregator_rule' });
  assert.throws(() => makeProfile({ rules: { custom: [{ type: 'USER-AGENT', value: 'x', policy: 'proxy' }] } }), { code: 'invalid_aggregator_rule' });
  const profile = makeProfile({ rules: { custom: [{ type: 'ip-cidr', value: '1.2.3.4', policy: 'direct' }] } });
  assert.deepEqual(profile.rules.custom, [{ type: 'IP-CIDR', value: '1.2.3.4/32', policy: 'direct' }]);
});

test('detectRegion prefers flags and does not match letters inside words', () => {
  assert.equal(detectRegion('🇯🇵 Node 1').id, 'jp');
  assert.equal(detectRegion('美国 US 02').id, 'us');
  assert.equal(detectRegion('RUSSIA 01'), null);
  assert.equal(detectRegion('Japan Tokyo').id, 'jp');
});

test('selectAggregatedNodes filters, dedupes connections and keeps output names unique', () => {
  const nodes = [...NODES, ssNode('a1', '重复连接', 'sub_b', { id: 'b9' })];
  const { entries, stats } = selectAggregatedNodes(makeProfile(), SOURCES, nodes);
  const names = entries.map((entry) => entry.name);
  assert.deepEqual(names, ['🇭🇰 香港 01', '美国 US 02', '🇭🇰 香港 01 · 机场B', 'Japan Tokyo']);
  assert.equal(stats.filtered, 1);
  assert.equal(stats.duplicates, 1);
  assert.equal(entries[2].sourceId, 'sub_b');
});

test('selectAggregatedNodes honours source scope, manual nodes, renames and source prefixes', () => {
  const profile = makeProfile({
    sources: { all: false, subscriptionIds: ['sub_b'], includeManualNodes: true },
    naming: { sourcePrefix: true, renames: [{ pattern: 'Tokyo', replace: '东京' }] }
  });
  const { entries } = selectAggregatedNodes(profile, SOURCES, NODES);
  assert.deepEqual(entries.map((entry) => entry.name), ['[机场B] 🇭🇰 香港 01', '[机场B] Japan 东京', '[手动节点] manual node']);
});

test('buildAggregationPlan emits region, source, preset and final groups with rules in order', () => {
  const profile = makeProfile({
    groups: { perSource: true },
    rules: {
      custom: [
        { type: 'DOMAIN-SUFFIX', value: 'example.com', policy: 'region:jp' },
        { type: 'DOMAIN', value: 'x.test', policy: 'region:sg' },
        { type: 'GEOSITE', value: 'bilibili', policy: 'preset:cn' }
      ]
    }
  });
  const selection = selectAggregatedNodes(profile, SOURCES, NODES);
  const plan = buildAggregationPlan(profile, selection, SOURCES);
  const groupNames = plan.groups.map((group) => group.name);
  assert.deepEqual(groupNames.slice(0, 2), ['🚀 节点选择', '♻️ 自动选择']);
  assert.ok(groupNames.includes('🇭🇰 香港节点'));
  assert.ok(groupNames.includes('📦 机场A'));
  assert.ok(groupNames.includes('🤖 AI 服务'));
  assert.ok(!groupNames.includes('🇸🇬 新加坡节点'), 'empty regions are omitted');
  assert.equal(plan.rules[0].match.value, 'geosite-private');
  assert.deepEqual(plan.rules[2], { match: { type: 'domain-suffix', value: 'example.com' }, target: { kind: 'group', name: '🇯🇵 日本节点' }, noResolve: false });
  assert.deepEqual(plan.rules[3].target, { kind: 'group', name: '🚀 节点选择' });
  assert.ok(plan.warnings.includes('aggregator_policy_fallback:rule:DOMAIN,x.test:region:sg'));
  assert.deepEqual(plan.rules[4].target, { kind: 'group', name: '🎯 国内直连' });
  assert.equal(plan.final.name, '🐟 漏网之鱼');
  const cnGroup = plan.groups.find((group) => group.name === '🎯 国内直连');
  assert.deepEqual(cnGroup.members[0], { kind: 'direct' });
});

test('buildAggregationPlan turns reject presets into rule actions when groups cannot hold REJECT', () => {
  const profile = makeProfile({ rules: { presets: [{ id: 'ads', enabled: true, policy: 'reject' }] } });
  const selection = selectAggregatedNodes(profile, SOURCES, NODES);
  const plan = buildAggregationPlan(profile, selection, SOURCES, { rejectInGroups: false });
  assert.ok(!plan.groups.some((group) => group.name === '🛑 广告拦截'));
  assert.ok(plan.groups.every((group) => group.members.every((member) => member.kind !== 'reject')));
  const adsRule = plan.rules.find((rule) => rule.match.value === 'geosite-category-ads-all');
  assert.deepEqual(adsRule.target, { kind: 'reject' });
});

test('renderers produce mihomo YAML, sing-box JSON and base64 URIs from the same plan', () => {
  const profile = makeProfile({ rules: { custom: [{ type: 'IP-CIDR', value: '2001:db8::/32', policy: 'direct' }] } });
  const { service } = createService(createSourcePort());
  const mihomo = service.render(profile, getRenderer('clash'));
  assert.match(mihomo.content, /^mixed-port: 7890/m);
  assert.match(mihomo.content, /"IP-CIDR6,2001:db8::\/32,DIRECT,no-resolve"/);
  assert.match(mihomo.content, /"RULE-SET,geosite-geolocation-not-cn,🌍 国外网站"/);
  assert.match(mihomo.content, /geolocation-!cn\.mrs/);
  assert.match(mihomo.content, /"MATCH,🐟 漏网之鱼"/);
  assert.equal(mihomo.stats.nodes, 4);

  const singBox = JSON.parse(service.render(profile, getRenderer('singbox')).content);
  assert.equal(singBox.route.final, '🐟 漏网之鱼');
  assert.ok(singBox.outbounds.some((outbound) => outbound.type === 'urltest' && outbound.tag === '♻️ 自动选择'));
  assert.ok(singBox.route.rule_set.every((ruleSet) => ruleSet.url.endsWith('.srs')));
  assert.deepEqual(singBox.dns.rules, [{ rule_set: ['geosite-cn'], server: 'dns-direct' }]);

  const base64 = service.render(profile, getRenderer('base64'));
  const uris = Buffer.from(base64.content, 'base64').toString('utf8').split('\n');
  assert.equal(uris.length, 4);
  assert.ok(uris.every((uri) => uri.startsWith('ss://')));
  assert.ok(uris.some((uri) => decodeURIComponent(uri).endsWith('#🇭🇰 香港 01 · 机场B')));
});

test('detectRendererByUserAgent maps common clients to formats', () => {
  assert.equal(detectRendererByUserAgent('clash-verge/v2.0').id, 'mihomo');
  assert.equal(detectRendererByUserAgent('SFM/1.12 (sing-box 1.12.0)').id, 'sing-box');
  assert.equal(detectRendererByUserAgent('Shadowrocket/2070').id, 'base64');
  assert.equal(detectRendererByUserAgent('').id, 'mihomo');
});

test('profile store creates the file only on write and rotates tokens', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-aggregator-store-'));
  const filePath = path.join(dir, 'aggregator.json');
  const store = new SubscriptionAggregatorStore({ filePath });
  assert.deepEqual(store.listProfiles(), []);
  assert.equal(fs.existsSync(filePath), false);
  const saved = store.saveProfile({ name: '甲' });
  assert.match(saved.id, /^agg_[0-9a-f]{12}$/);
  assert.match(saved.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(store.findProfileByToken(saved.token).id, saved.id);
  const rotated = store.rotateToken(saved.id);
  assert.notEqual(rotated.token, saved.token);
  assert.equal(store.findProfileByToken(saved.token), null);
  assert.throws(() => store.saveProfile({ id: 'agg_missing' }), { code: 'aggregator_profile_not_found' });
  assert.equal(store.deleteProfile(saved.id), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('serveSubscription refreshes stale sources once, aggregates userinfo and sets client headers', async () => {
  const port = createSourcePort();
  const { service, store, dir } = createService(port);
  const profile = store.saveProfile({ name: '我的聚合', refreshHours: 1 });
  const result = await service.serveSubscription(profile.token, { userAgent: 'clash.meta' });
  assert.equal(result.status, 200);
  assert.equal(result.headers['Content-Type'], 'text/yaml; charset=utf-8');
  assert.match(result.headers['Content-Disposition'], /filename\*=UTF-8''%E6%88%91%E7%9A%84%E8%81%9A%E5%90%88\.yaml/);
  assert.equal(result.headers['subscription-userinfo'], 'upload=4; download=6; total=150; expire=1500');
  assert.equal(result.headers['profile-update-interval'], '1');
  assert.deepEqual(port.calls.filter((call) => call[0] === 'sync').map((call) => call[1]).sort(), ['sub_a', 'sub_b']);

  const missing = await service.serveSubscription('nope'.padEnd(43, 'y'), {});
  assert.equal(missing.status, 404);
  const bad = await service.serveSubscription(profile.token, { target: 'surge' });
  assert.equal(bad.status, 400);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('serveSubscription answers from stored nodes when source refresh exceeds the deadline', async () => {
  let release;
  const port = createSourcePort({ syncSource: () => new Promise((resolve) => { release = resolve; }) });
  const { service, store, dir } = createService(port, { refreshDeadlineMs: 20 });
  const profile = store.saveProfile({ name: '慢源', refreshHours: 1 });
  const result = await service.serveSubscription(profile.token, { target: 'base64' });
  assert.equal(result.status, 200);
  assert.equal(service.inFlightSyncs.size, 2, 'slow syncs keep running in the background');
  release({ ok: true });
  await new Promise(setImmediate);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('syncSource coalesces concurrent syncs of the same subscription', async () => {
  let resolveSync;
  let calls = 0;
  const port = createSourcePort({ syncSource: () => { calls += 1; return new Promise((resolve) => { resolveSync = resolve; }); } });
  const { service, dir } = createService(port);
  const first = service.syncSource('sub_a');
  const second = service.syncSource('sub_a');
  await new Promise(setImmediate);
  resolveSync({ ok: true, count: 3 });
  assert.deepEqual(await first, { ok: true, count: 3 });
  assert.deepEqual(await second, { ok: true, count: 3 });
  assert.equal(calls, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('saveSource syncs new or re-pointed subscriptions but not renames', async () => {
  const port = createSourcePort();
  const { service, dir } = createService(port);
  const created = await service.saveSource({ name: '新订阅', url: 'https://c.example/sub' });
  assert.deepEqual(created.sync, { ok: true, count: 1 });
  const renamed = await service.saveSource({ id: 'sub_a', name: '改名', url: 'https://a.example/sub' });
  assert.equal(renamed.sync, undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('subscription userinfo parses, aggregates and formats', () => {
  assert.deepEqual(parseSubscriptionUserInfo('upload=1; download=2; total=10; expire=0'), { upload: 1, download: 2, total: 10, expire: 0 });
  assert.equal(parseSubscriptionUserInfo('garbage'), null);
  const merged = aggregateSubscriptionUserInfo([{ upload: 1, download: 2, total: 10, expire: 0 }, null, { upload: 1, download: 1, total: 5, expire: 99 }]);
  assert.deepEqual(merged, { upload: 2, download: 3, total: 15, expire: 99 });
  assert.equal(formatSubscriptionUserInfo(merged), 'upload=2; download=3; total=15; expire=99');
});

test('SubscriptionFetcher returns subscription-userinfo from the response headers', async () => {
  const fetcher = new SubscriptionFetcher({
    resolveHost: async () => ['93.184.216.34'],
    dispatcherFactory: () => ({ async close() {} }),
    requestImpl: async () => ({
      statusCode: 200,
      headers: { 'subscription-userinfo': 'upload=5; download=6; total=100; expire=1700000000' },
      body: Readable.from(['ss://x'])
    })
  });
  const result = await fetcher.fetch('https://subscription.example/sub');
  assert.deepEqual(result.userInfo, { upload: 5, download: 6, total: 100, expire: 1700000000 });
});
