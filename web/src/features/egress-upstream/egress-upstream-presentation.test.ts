import assert from 'node:assert/strict';
import test from 'node:test';

import {
  countriesOf,
  countryFlag,
  describeAccountEgress,
  describeScopeSummary,
  describeVerdict,
  formatTtl,
  nodeInScope,
  sameUpstreamUnbound,
  summarizeRule,
  summarizeScope
} from './egress-upstream-presentation.ts';

function node(name: string, country: string, status: string, extra: Record<string, unknown> = {}) {
  return {
    name,
    identity: `ss|${name}|443`,
    label: name,
    geo: country ? { country } : null,
    geoText: '',
    groups: [],
    verdict: { status, source: 'hint', detail: '', soft: true, ruleId: '' },
    evidence: null,
    ...extra
  } as never;
}

test('verdict labels distinguish rule / evidence / hint', () => {
  assert.deepEqual(describeVerdict({ status: 'denied', source: 'rule', soft: false }), { label: '规则拒绝', tone: 'error' });
  assert.deepEqual(describeVerdict({ status: 'denied', source: 'evidence', soft: false }), { label: '实测被拒', tone: 'error' });
  assert.deepEqual(describeVerdict({ status: 'denied', source: 'hint', soft: true }), { label: '提示拒绝', tone: 'warning' });
  assert.equal(describeVerdict({ status: 'allowed', source: 'evidence', soft: false }).label, '实测可用');
  assert.equal(describeVerdict({ status: 'allowed', source: 'geo', soft: true }).label, '位置允许');
  assert.equal(describeVerdict({ status: 'pending', source: 'none', soft: false }).label, '查询位置中');
  assert.equal(describeVerdict(null).label, '未知');
});

test('rules, flags and ttl read naturally', () => {
  assert.equal(countryFlag('us'), '🇺🇸');
  assert.equal(countryFlag('x'), '');
  assert.equal(summarizeRule({ effect: 'deny', match: { country: ['HK', 'MO'], region: [], city: ['hong kong'], asn: [], cidr: [], nodes: [], groups: [] } }),
    '拒绝 · 国家/地区 HK、MO 且 城市 hong kong');
  assert.equal(formatTtl(7 * 24 * 3600 * 1000), '7 天');
  assert.equal(formatTtl(12 * 3600 * 1000), '12 小时');
  assert.equal(formatTtl(90 * 1000), '2 分钟');
});

test('scope summary counts usable / denied / pending inside the selection', () => {
  const nodes = [node('hk', 'HK', 'denied'), node('us', 'US', 'allowed', { groups: ['p:us'] }), node('xx', '', 'pending')];
  assert.equal(nodeInScope(nodes[1], { kind: 'groups', groups: ['p:us'], nodes: [] }), true);
  assert.equal(nodeInScope(nodes[0], { kind: 'nodes', groups: [], nodes: ['ss|us|443'] }), false);
  const all = summarizeScope(nodes, { kind: 'all', groups: [], nodes: [] });
  assert.deepEqual(all, { inScope: 3, usable: 1, denied: 1, pending: 1 });
  assert.equal(describeScopeSummary(all).text, '将使用 1 个节点（排除 1 个被拒，1 个待查位置）');
  assert.equal(describeScopeSummary(summarizeScope(nodes, { kind: 'nodes', groups: [], nodes: ['ss|hk|443'] })).tone, 'error');
  assert.equal(describeScopeSummary(summarizeScope(nodes, { kind: 'nodes', groups: [], nodes: ['ss|xx|443'] })).tone, 'warning');
  assert.deepEqual(countriesOf(nodes), [{ code: 'HK', count: 1 }, { code: 'US', count: 1 }]);
});

test('same-upstream prompt lists other unbound accounts only', () => {
  const upstream = {
    accounts: [
      { accountRef: 'a', egress: null },
      { accountRef: 'b', egress: null },
      { accountRef: 'c', egress: { mode: 'url' } }
    ]
  } as never;
  assert.deepEqual(sameUpstreamUnbound(upstream, 'a').map((account: { accountRef: string }) => account.accountRef), ['b']);
  assert.deepEqual(sameUpstreamUnbound(null, 'a'), []);
});

test('account egress badge: denied network wins, pool shows lane', () => {
  assert.equal(describeAccountEgress({ accountRef: 'a', provider: 'claude', label: '', egress: null, lane: null,
    network: { exit: 'direct', status: 'denied', source: 'hint', detail: 'x' } } as never).label, '网络被拒');
  assert.equal(describeAccountEgress({ accountRef: 'a', provider: 'claude', label: '', egress: { mode: 'pool', retired: false, strategy: 'sticky' },
    lane: { activeNode: 'node-1', activeLabel: 'US01', blocked: '', allowedCount: 3, scopeCount: 4 }, network: null } as never).detail, 'US01 · 可用 3/4');
});

test('bulk quick-select and shared-upstream detection', async () => {
  const { quickSelectAccounts, commonUpstream } = await import('./egress-upstream-presentation.ts');
  const upstreams = [
    { id: 'u1', accounts: [
      { accountRef: 'a', egress: null, network: { status: 'denied' } },
      { accountRef: 'b', egress: { mode: 'url' }, network: { status: 'allowed' } }
    ] },
    { id: 'u2', accounts: [{ accountRef: 'c', egress: null, network: null }] }
  ] as never;
  assert.deepEqual(quickSelectAccounts(upstreams, 'unbound'), ['a', 'c']);
  assert.deepEqual(quickSelectAccounts(upstreams, 'denied'), ['a']);
  assert.deepEqual(quickSelectAccounts(upstreams, 'none'), []);
  assert.equal((commonUpstream(upstreams, ['a', 'b']) as { id: string } | null)?.id, 'u1');
  assert.equal(commonUpstream(upstreams, ['a', 'c']), null);
  assert.equal(commonUpstream(upstreams, []), null);
});

test('session strategy badge', async () => {
  const { describeAccountEgress } = await import('./egress-upstream-presentation.ts');
  assert.equal(describeAccountEgress({ accountRef: 'a', provider: 'opencode', label: '', egress: { mode: 'pool', retired: false, strategy: 'session' },
    lane: null, network: null } as never).label, '出口池 · 会话独占');
});
