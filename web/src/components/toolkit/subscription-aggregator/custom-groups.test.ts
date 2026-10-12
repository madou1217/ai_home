import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assignPresetsToGroup,
  buildMemberOptions,
  buildNodeOptions,
  countGroupReferences,
  createCustomGroup,
  describeGroupRemoval,
  groupNameProblem,
  matchGroupNodes,
  memberCandidateGroups,
  removeGroupReferences
} from './custom-groups.ts';
import { formatQuickRule, parseQuickRule, upsertCustomRule } from './rule-input.ts';
import type { AggregatorCustomGroup, AggregatorDraftNode, AggregatorProfileInput } from './types.ts';

function group(id: string, members: string[] = [], name = id): AggregatorCustomGroup {
  return { id, name, type: 'select', members, nodes: { include: '', exclude: '', names: [] } };
}

const NODES: AggregatorDraftNode[] = [
  { name: '🇭🇰 香港 01', protocol: 'vless', region: 'hk', source: '机场 A' },
  { name: '🇯🇵 日本 01', protocol: 'vless', region: 'jp', source: '机场 A' },
  { name: '🇯🇵 日本 02 IPLC', protocol: 'trojan', region: 'jp', source: '机场 B' }
];

const CATALOG_PRESETS = [
  { id: 'ai', defaultPolicy: 'proxy' },
  { id: 'youtube', defaultPolicy: 'proxy' },
  { id: 'ads', defaultPolicy: 'reject' }
];

function rules(): AggregatorProfileInput['rules'] {
  return {
    presets: [
      { id: 'ai', enabled: true, policy: 'group:a' },
      { id: 'youtube', enabled: false, policy: 'proxy' },
      { id: 'ads', enabled: true, policy: 'group:a' }
    ],
    custom: [
      { type: 'DOMAIN-SUFFIX', value: 'chatgpt.com', policy: 'group:a' },
      { type: 'DOMAIN-SUFFIX', value: 'x.com', policy: 'direct' }
    ],
    finalPolicy: 'group:a'
  };
}

test('new groups get a server-shaped id and the first free name', () => {
  const created = createCustomGroup([group('grp_00000001', [], '策略组 1')], () => 'abcd1234');
  assert.equal(created.id, 'grp_abcd1234');
  assert.equal(created.name, '策略组 2');
  assert.equal(created.type, 'url-test');
  assert.match(createCustomGroup([]).id, /^grp_[0-9a-f]{8}$/);
});

test('group names follow the server rules', () => {
  const groups = [group('a', [], 'AI'), group('b', [], 'AI '), group('c', [], 'YouTube')];
  assert.equal(groupNameProblem('AI', [], groups), '和其它策略组重名');
  assert.equal(groupNameProblem('YouTube', [], groups), '');
  assert.equal(groupNameProblem('🚀 节点选择', ['🚀 节点选择'], groups), '和自动生成的策略组重名');
  assert.equal(groupNameProblem('A,B', [], groups), '名称不能包含逗号、等号或换行');
  assert.equal(groupNameProblem('A\tB', [], groups), '名称不能包含逗号、等号或换行');
  assert.equal(groupNameProblem('   ', [], groups), '');
});

test('member candidates leave out the group itself and groups that already use it', () => {
  const groups = [group('a', ['group:b']), group('b', ['group:c']), group('c'), group('d')];
  assert.deepEqual(memberCandidateGroups(groups, 'c').map((item) => item.id), ['d']);
  assert.deepEqual(memberCandidateGroups(groups, 'a').map((item) => item.id), ['b', 'c', 'd']);

  const options = buildMemberOptions({
    catalog: { regions: [{ id: 'jp', code: 'JP', name: '日本', flag: '🇯🇵' }, { id: 'kr', code: 'KR', name: '韩国', flag: '🇰🇷' }], presets: [] },
    sources: [{ id: 'sub_a', name: '机场 A' }],
    groups,
    selfId: 'c',
    enabledRegions: ['jp'],
    includeSources: false,
    nodes: NODES
  });
  assert.deepEqual(options.map((item) => item.label), ['内置', '自建组', '地区']);
  assert.deepEqual(options[1].options, [{ label: 'd', value: 'group:d' }]);
  assert.deepEqual(options[2].options.map((item) => item.label), ['🇯🇵 日本节点 · 2 个节点', '🇰🇷 韩国节点（未开启这个地区分组）']);
});

test('node matching mirrors the server: picked or included, minus excluded', () => {
  const match = matchGroupNodes({ include: 'iplc|香港', exclude: '香港', names: ['🇯🇵 日本 01', '已删除的节点'] }, NODES);
  assert.deepEqual(match.nodes.map((node) => node.name), ['🇯🇵 日本 01', '🇯🇵 日本 02 IPLC']);
  assert.deepEqual(match.missingNames, ['已删除的节点']);
  assert.equal(matchGroupNodes({ include: '(', exclude: '', names: [] }, NODES).invalid, 'include');
  assert.deepEqual(matchGroupNodes(undefined, NODES).nodes, []);

  const options = buildNodeOptions(NODES, ['已删除的节点']);
  assert.deepEqual(options.map((item) => item.label), ['机场 A', '机场 B', '已不在订阅里']);
  assert.deepEqual(options[2].options, [{ label: '已删除的节点（已失效）', value: '已删除的节点' }]);
});

test('deleting a group cleans every reference and explains what changes', () => {
  const groups = [group('a', [], 'AI'), group('b', ['group:a', 'proxy'], 'YouTube')];
  const references = countGroupReferences(groups, rules(), 'a');
  assert.deepEqual(references, { groups: ['YouTube'], presets: 2, rules: 1, final: true });
  assert.equal(describeGroupRemoval(references), '从「YouTube」里去掉；2 个规则组恢复默认策略；1 条自定义规则和漏网之鱼改走节点选择');
  assert.equal(describeGroupRemoval(countGroupReferences(groups, rules(), 'b')), '');

  const cleaned = removeGroupReferences(groups, rules(), 'a', CATALOG_PRESETS);
  assert.deepEqual(cleaned.groups.map((item) => [item.id, item.members]), [['b', ['proxy']]]);
  assert.deepEqual(cleaned.rules.presets.map((preset) => preset.policy), ['proxy', 'proxy', 'reject']);
  assert.deepEqual(cleaned.rules.custom.map((rule) => rule.policy), ['proxy', 'direct']);
  assert.equal(cleaned.rules.finalPolicy, 'proxy');
});

test('usage edits: presets switch to the group and back, site rules are not duplicated', () => {
  const presets = assignPresetsToGroup(rules().presets, ['youtube'], 'a', CATALOG_PRESETS);
  assert.deepEqual(presets, [
    { id: 'ai', enabled: true, policy: 'proxy' },
    { id: 'youtube', enabled: true, policy: 'group:a' },
    { id: 'ads', enabled: true, policy: 'reject' }
  ]);

  const added = upsertCustomRule(rules().custom, { type: 'DOMAIN-SUFFIX', value: 'openai.com', policy: 'group:b' });
  assert.deepEqual(added[added.length - 1], { type: 'DOMAIN-SUFFIX', value: 'openai.com', policy: 'group:b' });
  const moved = upsertCustomRule(rules().custom, { type: 'DOMAIN-SUFFIX', value: 'x.com', policy: 'group:b' });
  assert.equal(moved.length, 2);
  assert.equal(moved[1].policy, 'group:b');
});

test('quick rules understand domains, urls, IPs and prefixed rule sets', () => {
  const cases: Array<[string, ReturnType<typeof parseQuickRule>]> = [
    ['chatgpt.com', { type: 'DOMAIN-SUFFIX', value: 'chatgpt.com' }],
    ['https://www.YouTube.com/watch?v=1', { type: 'DOMAIN-SUFFIX', value: 'youtube.com' }],
    ['*.openai.com', { type: 'DOMAIN-SUFFIX', value: 'openai.com' }],
    ['www.com', { type: 'DOMAIN-SUFFIX', value: 'www.com' }],
    ['domain:www.google.com', { type: 'DOMAIN', value: 'www.google.com' }],
    ['1.1.1.1', { type: 'IP-CIDR', value: '1.1.1.1/32' }],
    ['10.0.0.0/8', { type: 'IP-CIDR', value: '10.0.0.0/8' }],
    ['2001:DB8::/32', { type: 'IP-CIDR', value: '2001:db8::/32' }],
    ['geosite:Netflix', { type: 'GEOSITE', value: 'netflix' }],
    ['GEOIP：jp', { type: 'GEOIP', value: 'jp' }],
    ['keyword:google', { type: 'DOMAIN-KEYWORD', value: 'google' }],
    ['openai', { type: 'DOMAIN-KEYWORD', value: 'openai' }],
    ['999.1.1.1', null],
    ['10.0.0.0/33', null],
    ['a b', null],
    ['geosite:bad name', null],
    ['', null]
  ];
  for (const [input, expected] of cases) assert.deepEqual(parseQuickRule(input), expected, input);

  for (const text of ['chatgpt.com', 'domain:www.google.com', '10.0.0.0/8', 'geosite:netflix', 'keyword:google']) {
    const rule = parseQuickRule(text);
    assert.ok(rule);
    assert.deepEqual(parseQuickRule(formatQuickRule(rule)), rule, text);
  }
});
