'use strict';

// 自建策略组：配置约束（成环、重名、引用不存在的组）、规划（成员解析、按名称规则 / 勾选选节点、
// 安全地放进节点选择、解析不到的成员去掉）、各格式的策略写法（含 sing-box 降级与测速组展开嵌套组）。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const YAML = require('yaml');

const { normalizeProfile } = require('../lib/cli/services/toolkit/subscription-aggregator/profile-schema');
const { buildAggregationPlan } = require('../lib/cli/services/toolkit/subscription-aggregator/aggregation-plan');
const { selectAggregatedNodes } = require('../lib/cli/services/toolkit/subscription-aggregator/node-selection');
const { SubscriptionAggregatorStore } = require('../lib/cli/services/toolkit/subscription-aggregator/profile-store');
const { SubscriptionAggregatorService } = require('../lib/cli/services/toolkit/subscription-aggregator/aggregator-service');

function ssNode(id, name) {
  return { id, name, protocol: 'shadowsocks', server: `${id}.example`, port: 8388, cipher: 'aes-256-gcm', password: id, subscriptionId: 'sub_a' };
}

const NODES = [ssNode('hk1', '🇭🇰 香港 01'), ssNode('jp1', '🇯🇵 日本 01'), ssNode('jp2', '🇯🇵 日本 02 IPLC'), ssNode('us1', '🇺🇸 美国 01')];
const SOURCES = [{ id: 'sub_a', name: '机场 A', url: 'https://a.example/sub', nodeCount: NODES.length, lastSyncedAt: 1 }];

const YOUTUBE = {
  id: 'grp_yt',
  name: 'YouTube 低延迟',
  type: 'url-test',
  members: ['region:jp'],
  nodes: { include: 'IPLC|香港', exclude: '', names: ['🇺🇸 美国 01'] },
  tolerance: 80
};
const AI = { id: 'grp_ai', name: 'AI', type: 'fallback', members: ['proxy', 'group:grp_yt'] };

function profileWith(input = {}) {
  return normalizeProfile({ name: '测试', ...input }, { id: 'agg_1', token: 'tok', createdAt: 1 }, 1);
}

function planFor(profile, capabilities = {}) {
  return buildAggregationPlan(profile, selectAggregatedNodes(profile, SOURCES, NODES), SOURCES, capabilities);
}

test('custom groups are validated: names, cycles, missing members and preset members are rejected', () => {
  const profile = profileWith({ groups: { custom: [YOUTUBE, { name: '新组' }] } });
  const [yt, fresh] = profile.groups.custom;
  assert.deepEqual(yt, {
    id: 'grp_yt', name: 'YouTube 低延迟', type: 'url-test', members: ['region:jp'],
    nodes: { include: 'IPLC|香港', exclude: '', names: ['🇺🇸 美国 01'] }, testUrl: '', interval: 0, tolerance: 80
  });
  assert.match(fresh.id, /^grp_[0-9a-f]{8}$/);
  assert.deepEqual([fresh.type, fresh.members], ['select', []]);

  const rejects = (custom, code) => assert.throws(() => profileWith({ groups: { custom } }), { code });
  rejects([{ name: 'A' }, { name: 'A' }], 'duplicate_aggregator_group_name');
  rejects([{ name: '🚀 节点选择' }], 'duplicate_aggregator_group_name');
  rejects([{ name: '📹 YouTube' }], 'duplicate_aggregator_group_name');
  rejects([{ name: '🇯🇵 日本节点' }], 'duplicate_aggregator_group_name');
  rejects([{ name: 'A,B' }], 'invalid_aggregator_group_name');
  rejects([{ name: 'A=B' }], 'invalid_aggregator_group_name');
  rejects([{ name: 'A\nB' }], 'invalid_aggregator_group_name');
  rejects([{ id: 'a', name: 'A', members: ['group:b'] }, { id: 'b', name: 'B', members: ['group:a'] }], 'invalid_aggregator_group_cycle');
  rejects([{ id: 'a', name: 'A', members: ['group:a'] }], 'invalid_aggregator_group_cycle');
  rejects([{ id: 'a', name: 'A', members: ['group:gone'] }], 'invalid_aggregator_group_member');
  rejects([{ id: 'a', name: 'A', members: ['preset:ai'] }], 'invalid_aggregator_policy');

  // 规则、预设与漏网之鱼都能指向自建组。
  const routed = profileWith({
    groups: { custom: [YOUTUBE] },
    rules: { custom: [{ type: 'DOMAIN-SUFFIX', value: 'chatgpt.com', policy: 'group:grp_yt' }], finalPolicy: 'group:grp_yt' }
  });
  assert.deepEqual([routed.rules.custom[0].policy, routed.rules.finalPolicy], ['group:grp_yt', 'group:grp_yt']);
});

test('the plan resolves members, picks nodes by rule or by name and keeps proxy-dependent groups out of 节点选择', () => {
  const profile = profileWith({
    groups: { custom: [YOUTUBE, AI, { id: 'grp_kr', name: '韩国专用', members: ['region:kr'] }] },
    rules: {
      custom: [{ type: 'DOMAIN-SUFFIX', value: 'chatgpt.com', policy: 'group:grp_ai' }],
      presets: [{ id: 'youtube', enabled: true, policy: 'group:grp_yt' }]
    }
  });
  const plan = planFor(profile);
  const group = (name) => plan.groups.find((item) => item.name === name);
  const names = (members) => members.map((member) => member.name || member.kind);

  assert.deepEqual(names(group('YouTube 低延迟').members), ['🇯🇵 日本节点', '🇭🇰 香港 01', '🇯🇵 日本 02 IPLC', '🇺🇸 美国 01']);
  assert.deepEqual([group('YouTube 低延迟').type, group('YouTube 低延迟').tolerance], ['url-test', 80]);
  assert.equal(group('YouTube 低延迟').testUrl, profile.groups.testUrl, '留空的测速地址沿用配置');
  assert.deepEqual(names(group('AI').members), ['🚀 节点选择', 'YouTube 低延迟']);
  // 没有韩国节点：成员去掉并给出警告，组里用直连占位（不能回落到节点选择，否则会成环）。
  assert.deepEqual(group('韩国专用').members, [{ kind: 'direct' }]);
  assert.ok(plan.warnings.includes('aggregator_group_member_missing:韩国专用:region:kr'));

  const proxyMembers = names(group('🚀 节点选择').members);
  assert.ok(proxyMembers.includes('YouTube 低延迟'));
  assert.ok(!proxyMembers.includes('AI'), 'AI 组用到了节点选择，不能再放进节点选择');
  assert.equal(names(group('📹 YouTube').members)[0], 'YouTube 低延迟');
  assert.ok(names(group('📹 YouTube').members).includes('AI'), '预设组的可选项里有全部自建组');
  assert.deepEqual(plan.rules.find((rule) => rule.match.value === 'chatgpt.com').target, { kind: 'group', name: 'AI' });

  // 自建组排在节点选择 / 自动选择之后、预设组之前。
  assert.deepEqual(plan.groups.slice(0, 5).map((item) => item.name), ['🚀 节点选择', '♻️ 自动选择', 'YouTube 低延迟', 'AI', '韩国专用']);

  // 和节点同名的自建组加后缀（客户端里组和节点共用名字空间），引用它的规则跟着用新名字。
  const clash = profileWith({
    groups: { custom: [{ id: 'grp_us', name: '🇺🇸 美国 01', members: ['auto'] }] },
    rules: { custom: [{ type: 'DOMAIN', value: 'x.com', policy: 'group:grp_us' }] }
  });
  const clashPlan = planFor(clash);
  assert.ok(clashPlan.groups.some((item) => item.name === '🇺🇸 美国 01 2'));
  assert.deepEqual(clashPlan.rules.find((rule) => rule.match.value === 'x.com').target, { kind: 'group', name: '🇺🇸 美国 01 2' });

  // sing-box 没有故障转移：降级成延迟最低并说明。
  const singBoxPlan = planFor(profile, { rejectInGroups: false, groupTypes: ['select', 'url-test'] });
  assert.equal(singBoxPlan.groups.find((item) => item.name === 'AI').type, 'url-test');
  assert.ok(singBoxPlan.warnings.includes('aggregator_group_type_degraded:AI:fallback'));
});

function serviceWith(t, profileInput) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-aggregator-groups-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new SubscriptionAggregatorStore({ filePath: path.join(dir, 'aggregator.json'), now: () => 1 });
  const service = new SubscriptionAggregatorService({
    store,
    now: () => 1,
    sources: { listSources: () => SOURCES, listNodes: () => NODES, syncSource: async () => ({ ok: true }) }
  });
  return { service, profile: store.saveProfile({ name: '测试', refreshHours: 0, ...profileInput }) };
}

const STRATEGY_GROUPS = [
  YOUTUBE,
  AI,
  { id: 'grp_lb', name: '均衡', type: 'load-balance', members: ['region:jp'], strategy: 'round-robin' },
  { id: 'grp_hash', name: '固定', type: 'load-balance', members: ['region:jp'] }
];

test('each format writes the four strategies in its own syntax', (t) => {
  const { service, profile } = serviceWith(t, { groups: { custom: STRATEGY_GROUPS } });
  const content = (format) => service.preview(profile.id, format).content;

  const mihomo = YAML.parse(content('mihomo'))['proxy-groups'];
  const byName = (list, name) => list.find((item) => item.name === name);
  assert.deepEqual(
    [byName(mihomo, 'YouTube 低延迟').type, byName(mihomo, 'YouTube 低延迟').tolerance, byName(mihomo, 'AI').type, byName(mihomo, 'AI').url ? 'url' : ''],
    ['url-test', 80, 'fallback', 'url']
  );
  assert.deepEqual([byName(mihomo, '均衡').strategy, byName(mihomo, '固定').strategy], ['round-robin', 'consistent-hashing']);

  // Surge 的测速类组只放节点：引用的组展开成节点。
  const surge = content('surge');
  assert.match(surge, /^AI = fallback, (?:[^,]+, )*url=.+, interval=300, timeout=5$/m);
  assert.doesNotMatch(surge.match(/^YouTube 低延迟 = .*$/m)[0], /日本节点/);
  assert.match(surge, /^固定 = load-balance, .*, persistent=true$/m);
  assert.match(surge, /^均衡 = load-balance, (?:(?!persistent).)*$/m);

  const loon = content('loon');
  assert.match(loon, /^AI = fallback, .*max-timeout=3000$/m);
  assert.match(loon, /^均衡 = load-balance, .*algorithm=Round-Robin$/m);
  assert.match(loon, /^固定 = load-balance, .*algorithm=PCC$/m);

  const qx = content('quantumult-x');
  assert.match(qx, /^url-latency-benchmark=YouTube 低延迟, 🇯🇵 日本 01, 🇯🇵 日本 02 IPLC, 🇭🇰 香港 01, 🇺🇸 美国 01, check-interval=300, tolerance=80/m);
  assert.match(qx, /^available=AI, /m);
  assert.match(qx, /^round-robin=均衡, /m);
  assert.match(qx, /^dest-hash=固定, /m);

  const egern = YAML.parse(content('egern')).policy_groups;
  const egernGroup = (key, name) => egern.find((item) => item[key]?.name === name)?.[key];
  assert.equal(egernGroup('auto_test', 'YouTube 低延迟').tolerance, 80);
  assert.ok(egernGroup('fallback', 'AI'));
  assert.equal(egernGroup('load_balance', '均衡').algorithm, 'round_robin');
  assert.equal(egernGroup('load_balance', '固定').algorithm, 'hash');

  const singBox = service.preview(profile.id, 'sing-box');
  const outbounds = JSON.parse(singBox.content).outbounds;
  assert.equal(outbounds.find((item) => item.tag === 'AI').type, 'urltest');
  assert.ok(singBox.warnings.includes('aggregator_group_type_degraded:AI:fallback'));
});

test('the draft node preview lists what the unsaved profile would select', (t) => {
  const { service } = serviceWith(t, {});
  const result = service.previewNodes({ filter: { include: '日本' }, groups: { custom: [{ id: 'x', name: 'X', members: ['group:gone'] }] } });
  assert.deepEqual(result.nodes.map((node) => node.name), ['🇯🇵 日本 01', '🇯🇵 日本 02 IPLC']);
  assert.deepEqual(result.nodes[0], { id: 'jp1', name: '🇯🇵 日本 01', protocol: 'shadowsocks', region: 'jp', source: '机场 A', chain: '' });
  assert.throws(() => service.previewNodes({ filter: { include: '(' } }), { code: 'invalid_aggregator_pattern' });
});
