import assert from 'node:assert/strict';
import test from 'node:test';

import { RULE_SET_SUGGESTIONS, upsertCustomRule } from './rule-input.ts';
import { describeTraceEnd, describeTraceGroups, describeTraceRule, traceRuleCandidates } from './route-trace-presentation.ts';
import type { AggregatorRouteTrace, AggregatorRuleType } from './types.ts';

const PRESETS = [{ id: 'youtube', name: '📹 YouTube' }];
const GROUP_TYPES = [{ id: 'url-test' as const, name: '延迟最低' }, { id: 'fallback' as const, name: '故障转移' }];

test('trace rules say where the match came from', () => {
  assert.equal(describeTraceRule({ origin: { kind: 'custom', index: 1 }, type: 'domain-suffix', value: 'chatgpt.com' }, PRESETS), '自定义规则第 2 条（域名及子域名 chatgpt.com）');
  assert.equal(describeTraceRule({ origin: { kind: 'preset', id: 'youtube' }, type: 'geosite', value: 'youtube' }, PRESETS), '规则组「📹 YouTube」（GEOSITE youtube）');
  assert.equal(describeTraceRule({ origin: { kind: 'private' }, type: 'geoip', value: 'private' }, PRESETS), '内置：局域网与保留地址（GEOIP private）');
  assert.equal(describeTraceRule({ origin: { kind: 'final' }, type: 'final', value: '' }, PRESETS), '没有规则命中，走漏网之鱼');
});

test('trace paths name each group and where the traffic ends up', () => {
  const groups: AggregatorRouteTrace['groups'] = [
    { name: '📹 YouTube', type: 'select', members: ['YouTube 低延迟', '🚀 节点选择'], memberCount: 2 },
    { name: 'YouTube 低延迟', type: 'url-test', members: ['a', 'b', 'c', 'd', 'e', 'f', 'g'], memberCount: 9 }
  ];
  assert.deepEqual(describeTraceGroups(groups, GROUP_TYPES), ['📹 YouTube（手动选择，默认第一项）', 'YouTube 低延迟（延迟最低）']);
  assert.equal(describeTraceEnd({ groups, end: null }), '在 9 个成员里自动选：a、b、c、d、e、f 等');
  assert.equal(describeTraceEnd({ groups: [], end: { kind: 'direct', name: 'DIRECT' } }), '直连 DIRECT');
  assert.equal(describeTraceEnd({ groups: [], end: { kind: 'node', name: '🇯🇵 日本 01' } }), '节点 🇯🇵 日本 01');
});

test('rule candidates default to the main domain', () => {
  const pick = (value: string) => {
    const { candidates, defaultIndex } = traceRuleCandidates({ kind: 'domain', value });
    return [candidates.map((rule) => rule.value), candidates[defaultIndex].value];
  };
  assert.deepEqual(pick('www.youtube.com'), [['www.youtube.com', 'youtube.com'], 'youtube.com']);
  assert.deepEqual(pick('news.bbc.co.uk'), [['news.bbc.co.uk', 'bbc.co.uk', 'co.uk'], 'bbc.co.uk']);
  assert.deepEqual(pick('example.com'), [['example.com'], 'example.com']);
  assert.deepEqual(pick('localhost'), [['localhost'], 'localhost']);
  assert.deepEqual(traceRuleCandidates({ kind: 'ip', value: '2001:db8::1' }).candidates, [{ type: 'IP-CIDR', value: '2001:db8::1/128' }]);
});

test('upserting a rule changes the policy of an existing match instead of duplicating it', () => {
  const rules: Array<{ type: AggregatorRuleType; value: string; policy: string }> = [{ type: 'DOMAIN-SUFFIX', value: 'x.com', policy: 'direct' }];
  assert.deepEqual(upsertCustomRule(rules, { type: 'DOMAIN-SUFFIX', value: 'x.com', policy: 'proxy' }), [{ type: 'DOMAIN-SUFFIX', value: 'x.com', policy: 'proxy' }]);
  assert.equal(upsertCustomRule(rules, { type: 'DOMAIN', value: 'x.com', policy: 'proxy' }).length, 2);
  // 候选名只用服务端认可的字符（与 profile-schema 的 GEOSITE / GEOIP 校验一致）。
  for (const list of Object.values(RULE_SET_SUGGESTIONS)) {
    for (const item of list || []) assert.match(item.value, /^[a-z0-9!@._-]+$/);
  }
});
