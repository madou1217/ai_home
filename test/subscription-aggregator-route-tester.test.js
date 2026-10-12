'use strict';

// 规则测试：输入解析、按规划顺序命中、GEOSITE / GEOIP 判断、拉取失败的规则集、顺着默认成员走到底。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { buildAggregationPlan } = require('../lib/cli/services/toolkit/subscription-aggregator/aggregation-plan');
const { selectAggregatedNodes } = require('../lib/cli/services/toolkit/subscription-aggregator/node-selection');
const { normalizeProfile } = require('../lib/cli/services/toolkit/subscription-aggregator/profile-schema');
const { SubscriptionAggregatorStore } = require('../lib/cli/services/toolkit/subscription-aggregator/profile-store');
const { SubscriptionAggregatorService } = require('../lib/cli/services/toolkit/subscription-aggregator/aggregator-service');
const { parseRouteTarget, traceRoute } = require('../lib/cli/services/toolkit/subscription-aggregator/route-tester');

function ssNode(id, name) {
  return { id, name, protocol: 'shadowsocks', server: `${id}.example`, port: 8388, cipher: 'aes-256-gcm', password: id, subscriptionId: 'sub_a' };
}

const NODES = [ssNode('hk1', '🇭🇰 香港 01'), ssNode('jp1', '🇯🇵 日本 01'), ssNode('jp2', '🇯🇵 日本 02 IPLC')];
const SOURCES = [{ id: 'sub_a', name: '机场 A', url: 'https://a.example/sub', nodeCount: NODES.length, lastSyncedAt: 1 }];

const LISTS = {
  'geosite:private': [{ type: 'domain', value: 'localhost' }, { type: 'suffix', value: 'local' }],
  'geoip:private': [{ type: 'ip4', value: '10.0.0.0/8' }, { type: 'ip6', value: 'fc00::/7' }],
  'geosite:category-ai-!cn': [{ type: 'suffix', value: 'openai.com' }],
  'geosite:youtube': [{ type: 'suffix', value: 'youtube.com' }, { type: 'suffix', value: 'googlevideo.com' }],
  // 真实的 geosite:google 包含全部 YouTube 域名。
  'geosite:google': [{ type: 'suffix', value: 'google.com' }, { type: 'suffix', value: 'youtube.com' }],
  'geoip:telegram': [{ type: 'ip4', value: '91.108.4.0/22' }, { type: 'ip6', value: '2001:b28:f23d::/48' }],
  'geosite:cn': [{ type: 'suffix', value: 'cn' }, { type: 'domain', value: 'www.baidu.com' }],
  'geoip:cn': [{ type: 'ip4', value: '1.0.1.0/24' }]
};

function fakeLoader() {
  const calls = [];
  const loadEntries = async (ruleSet) => {
    const key = `${ruleSet.kind}:${ruleSet.name}`;
    calls.push(key);
    if (ruleSet.name === 'broken') throw Object.assign(new Error('boom'), { code: 'subscription_fetch_timeout' });
    return LISTS[key] || [];
  };
  return { calls, loadEntries };
}

const PROFILE_INPUT = {
  name: '测试',
  groups: {
    custom: [
      { id: 'grp_yt', name: 'YouTube 低延迟', type: 'url-test', members: ['region:jp'] },
      { id: 'grp_ai', name: 'AI', type: 'fallback', members: ['group:grp_yt', 'proxy'] }
    ]
  },
  rules: {
    presets: [{ id: 'youtube', enabled: true, policy: 'group:grp_yt' }],
    custom: [
      { type: 'GEOSITE', value: 'broken', policy: 'reject' },
      { type: 'DOMAIN-SUFFIX', value: 'chatgpt.com', policy: 'group:grp_ai' },
      { type: 'DOMAIN-KEYWORD', value: 'tracker', policy: 'reject' },
      { type: 'IP-CIDR', value: '203.0.113.0/24', policy: 'direct' }
    ]
  }
};

function planFor(input = PROFILE_INPUT) {
  const profile = normalizeProfile(input, { id: 'agg_1', token: 'tok', createdAt: 1 }, 1);
  return buildAggregationPlan(profile, selectAggregatedNodes(profile, SOURCES, NODES), SOURCES);
}

test('route targets accept urls, hosts with ports and IPv6 in brackets', () => {
  assert.deepEqual(parseRouteTarget('https://User@Chat.OpenAI.com:443/path?q=1'), { kind: 'domain', value: 'chat.openai.com' });
  assert.deepEqual(parseRouteTarget('1.2.3.4:443'), { kind: 'ip', value: '1.2.3.4' });
  assert.deepEqual(parseRouteTarget('[2001:db8::1]:443'), { kind: 'ip', value: '2001:db8::1' });
  assert.deepEqual(parseRouteTarget('2001:DB8::1'), { kind: 'ip', value: '2001:db8::1' });
  assert.deepEqual(parseRouteTarget('example.com.'), { kind: 'domain', value: 'example.com' });
  for (const bad of ['', '   ', 'bad host', 'a..b', 'x'.repeat(300)]) {
    assert.throws(() => parseRouteTarget(bad), { code: 'invalid_route_target' }, bad);
  }
});

test('rules are checked in plan order and the path follows each select group default', async () => {
  const plan = planFor();
  const { loadEntries } = fakeLoader();
  const trace = (input) => traceRoute(plan, input, { loadEntries });

  const local = await trace('localhost');
  assert.deepEqual([local.rule.origin, local.groups, local.end], [{ kind: 'private' }, [], { kind: 'direct', name: 'DIRECT' }]);

  // 自定义规则排在预设之前；拉取失败的规则集记下来并跳过。
  const chat = await trace('https://chatgpt.com/c/1');
  assert.deepEqual(chat.rule, { origin: { kind: 'custom', index: 1 }, type: 'domain-suffix', value: 'chatgpt.com' });
  assert.deepEqual(chat.groups.map((group) => [group.name, group.type]), [['AI', 'fallback']]);
  assert.deepEqual(chat.groups[0].members, ['YouTube 低延迟', '🚀 节点选择']);
  assert.equal(chat.end, null, '会自动选的组到此为止');
  assert.deepEqual(chat.unavailable, ['geosite:broken']);

  const video = await trace('rr3.googlevideo.com');
  assert.deepEqual(video.rule, { origin: { kind: 'preset', id: 'youtube' }, type: 'geosite', value: 'youtube' });
  assert.deepEqual(video.groups.map((group) => group.name), ['📹 YouTube', 'YouTube 低延迟']);
  assert.deepEqual(video.groups[1].members, ['🇯🇵 日本节点']);

  assert.equal((await trace('ads.tracker.example')).end.name, 'REJECT');
  assert.equal((await trace('www.baidu.com')).rule.value, 'cn');
  assert.equal((await trace('news.sina.cn')).end.name, 'DIRECT');

  // IP 只看 IP 规则（域名规则与 GEOSITE 跳过）。
  assert.deepEqual((await trace('203.0.113.9')).rule, { origin: { kind: 'custom', index: 3 }, type: 'ip-cidr', value: '203.0.113.0/24' });
  assert.equal((await trace('91.108.4.10')).rule.origin.id, 'telegram');
  assert.equal((await trace('2001:b28:f23d::1')).rule.origin.id, 'telegram');
  assert.deepEqual((await trace('10.1.2.3')).rule.origin, { kind: 'private' });
  assert.equal((await trace('1.0.1.9')).groups[0].name, '🎯 国内直连');

  // 都没命中：漏网之鱼 → 节点选择 → 自动选择（延迟最低，停在这里）。
  const other = await trace('example.org');
  assert.deepEqual(other.rule.origin, { kind: 'final' });
  assert.deepEqual(other.groups.map((group) => group.name), ['🐟 漏网之鱼', '🚀 节点选择', '♻️ 自动选择']);
  assert.ok(other.checked > 5);
});

test('presets match in catalog order even when a stored profile lists them differently', async () => {
  const profile = normalizeProfile(PROFILE_INPUT, { id: 'agg_1', token: 'tok', createdAt: 1 }, 1);
  // 旧版本保存的配置：Google 排在 YouTube 前面，读取时不会重新规范化。
  const stored = { ...profile, rules: { ...profile.rules, presets: [...profile.rules.presets].reverse() } };
  const plan = buildAggregationPlan(stored, selectAggregatedNodes(stored, SOURCES, NODES), SOURCES);
  const presetOrder = [...new Set(plan.rules.filter((rule) => rule.origin.kind === 'preset').map((rule) => rule.origin.id))];
  assert.ok(presetOrder.indexOf('youtube') < presetOrder.indexOf('google'));
  const youtube = await traceRoute(plan, 'www.youtube.com', fakeLoader());
  assert.deepEqual(youtube.rule.origin, { kind: 'preset', id: 'youtube' });
  assert.equal((await traceRoute(plan, 'mail.google.com', fakeLoader())).rule.origin.id, 'google');
});

test('only the rule sets the target can match are downloaded', async () => {
  const plan = planFor();
  const domainLoader = fakeLoader();
  await traceRoute(plan, 'example.org', domainLoader);
  assert.ok(domainLoader.calls.length > 0);
  assert.ok(domainLoader.calls.every((key) => key.startsWith('geosite:')));
  assert.equal(new Set(domainLoader.calls).size, domainLoader.calls.length, '每个规则集只拉一次');

  const ipLoader = fakeLoader();
  await traceRoute(plan, '8.8.8.8', ipLoader);
  assert.ok(ipLoader.calls.every((key) => key.startsWith('geoip:')));
});

test('the service traces a draft profile without saving it', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-route-tester-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new SubscriptionAggregatorStore({ filePath: path.join(dir, 'aggregator.json'), now: () => 1 });
  const service = new SubscriptionAggregatorService({
    store,
    now: () => 1,
    ruleSets: fakeLoader(),
    sources: { listSources: () => SOURCES, listNodes: () => NODES, syncSource: async () => ({ ok: true }) }
  });
  const result = await service.testRoute({ profile: PROFILE_INPUT, target: 'api.openai.com' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.rule.origin, { kind: 'preset', id: 'ai' });
  assert.equal(store.listProfiles().length, 0);
  await assert.rejects(service.testRoute({ profile: PROFILE_INPUT, target: 'no spaces allowed' }), { code: 'invalid_route_target' });
  await assert.rejects(
    service.testRoute({ profile: { groups: { custom: [{ id: 'a', name: 'A', members: ['group:a'] }] } }, target: 'x.com' }),
    { code: 'invalid_aggregator_group_cycle' }
  );
});
