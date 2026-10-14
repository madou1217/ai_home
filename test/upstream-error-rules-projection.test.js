'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  accountAcceptedByGo,
  collectUpstreamErrorRulesProjection,
  hasEnabledRules,
  hasUnacceptedEnabledRules,
  projectRule
} = require('../lib/server/upstream-error-rules-projection');

const RULE = {
  name: '额度耗尽',
  kind: 'quota_exhausted',
  enabled: true,
  statuses: [429],
  matchers: [{ source: 'body', operator: 'contains', value: 'INSUFFICIENT_BALANCE' }]
};

test('projectRule emits exactly the fields the Go projection decodes', () => {
  assert.deepEqual(projectRule(RULE), {
    name: '额度耗尽',
    kind: 'quota_exhausted',
    enabled: true,
    statuses: [429],
    matchers: [{ source: 'body', operator: 'contains', value: 'INSUFFICIENT_BALANCE' }]
  });
  // 旧版 field/pattern 形态原样保留；缺省 enabled 显式下发，避免 Go 把缺省当停用。
  assert.deepEqual(projectRule({
    name: '旧版', kind: 'rate_limited', statuses: [], matchers: [{ field: 'message', pattern: '^Too many' }]
  }), {
    name: '旧版', kind: 'rate_limited', enabled: true, statuses: [],
    matchers: [{ field: 'message', pattern: '^Too many' }]
  });
  // json 来源带路径。
  assert.deepEqual(projectRule({
    name: '结构化', kind: 'auth_invalid', enabled: false, statuses: [401],
    matchers: [{ source: 'json', operator: 'equals', path: 'error.code', value: 'invalid_api_key' }]
  }).matchers, [{ source: 'json', operator: 'equals', path: 'error.code', value: 'invalid_api_key' }]);
});

test('projectRule refuses shapes Go cannot execute faithfully', () => {
  assert.equal(projectRule(null), null);
  assert.equal(projectRule({ ...RULE, kind: 'made_up' }), null);
  assert.equal(projectRule({ ...RULE, statuses: [200] }), null, 'status whitelist is 400-599');
  assert.equal(projectRule({ ...RULE, statuses: '429' }), null);
  assert.equal(projectRule({ ...RULE, matchers: [] }), null);
  assert.equal(projectRule({ ...RULE, matchers: [{ source: 'header', operator: 'contains', value: 'x' }] }), null);
  assert.equal(projectRule({ ...RULE, matchers: [{ source: 'body', operator: 'fuzzy', value: 'x' }] }), null);
  assert.equal(projectRule({ ...RULE, matchers: [{ source: 'json', operator: 'equals', value: 'x' }] }), null, 'json needs a path');
  assert.equal(projectRule({ ...RULE, matchers: [{ source: 'body', operator: 'equals', value: { a: 1 } }] }), null);
  assert.equal(projectRule({ ...RULE, matchers: [{ field: 'header', pattern: 'x' }] }), null);
});

test('collectUpstreamErrorRulesProjection only pushes accounts with enabled rules', () => {
  const pools = {
    codex: [
      { accountRef: 'acct_codex_1', provider: 'codex', upstreamErrorRules: [RULE] },
      // 只有停用规则：不产生异常语义，也不触发交还。
      { accountRef: 'acct_codex_2', provider: 'codex', upstreamErrorRules: [{ ...RULE, enabled: false }] },
      { accountRef: 'acct_codex_3', provider: 'codex', upstreamErrorRules: [] }
    ],
    claude: [{ accountRef: 'acct_claude_1', provider: 'claude' }]
  };
  const projection = collectUpstreamErrorRulesProjection(pools);
  assert.deepEqual(projection.map((record) => record.account_ref), ['acct_codex_1']);
  assert.equal(projection[0].provider, 'codex');
  assert.deepEqual(projection[0].rules, projectRule(RULE) ? [projectRule(RULE)] : []);
});

test('collectUpstreamErrorRulesProjection maps refs, drops unmappable accounts and is stable', () => {
  const pools = {
    codex: [
      { accountRef: 'node_b', provider: 'codex', upstreamErrorRules: [RULE] },
      { accountRef: 'node_a', provider: 'codex', upstreamErrorRules: [RULE] },
      // 同步 rekey 后没有 Go 侧引用：Go 路由不到它，不需要投影。
      { accountRef: 'node_unmapped', provider: 'codex', upstreamErrorRules: [RULE] },
      // 规则形状无法忠实表达：整个账号退回 Node。
      { accountRef: 'node_broken', provider: 'codex', upstreamErrorRules: [{ ...RULE, kind: 'made_up' }] }
    ]
  };
  const goRefFor = (ref) => (ref === 'node_unmapped' ? '' : `go_${ref}`);
  const projection = collectUpstreamErrorRulesProjection(pools, { goRefFor });
  // 按 Node 引用排序 ⇒ 同一份规则表每次推送内容一致（内容未变不重复 PUT）。
  assert.deepEqual(projection.map((record) => record.account_ref), ['go_node_a', 'go_node_b']);
  assert.deepEqual(collectUpstreamErrorRulesProjection(pools, { goRefFor }), projection);
  // 两个 Node 引用指向同一个 Go 账号（身份合并）时只保留一份。
  const merged = collectUpstreamErrorRulesProjection({
    codex: [
      { accountRef: 'node_a', provider: 'codex', upstreamErrorRules: [RULE] },
      { accountRef: 'node_c', provider: 'codex', upstreamErrorRules: [RULE] }
    ]
  }, { goRefFor: () => 'go_shared' });
  assert.deepEqual(merged.map((record) => record.account_ref), ['go_shared']);
});

test('accepted refs decide whether the account may leave Node', () => {
  assert.equal(hasEnabledRules({ upstreamErrorRules: [RULE] }), true);
  assert.equal(hasEnabledRules({ upstreamErrorRules: [{ ...RULE, enabled: false }] }), false);
  assert.equal(hasEnabledRules({}), false);

  const accepted = new Set(['go_a']);
  assert.equal(accountAcceptedByGo('go_a', accepted), true);
  assert.equal(accountAcceptedByGo('node_a', accepted, (ref) => (ref === 'node_a' ? 'go_a' : '')), true);
  assert.equal(accountAcceptedByGo('node_b', accepted, () => ''), false);
  assert.equal(accountAcceptedByGo('go_a', new Set()), false, '空集合表示全部未承接');
  assert.equal(accountAcceptedByGo('go_a', null), false);
  assert.equal(accountAcceptedByGo('', accepted), false);
});


test('hasUnacceptedEnabledRules keeps Node for accounts Go has not taken over', () => {
  const pools = {
    codex: [
      { accountRef: 'node_a', provider: 'codex', upstreamErrorRules: [RULE] },
      { accountRef: 'node_plain', provider: 'codex' }
    ],
    claude: [{ accountRef: 'node_b', provider: 'claude', upstreamErrorRules: [{ ...RULE, enabled: false }] }]
  };
  // Go 承接 node_a（映射到 go_a）：池里已没有未承接的规则账号。
  assert.equal(hasUnacceptedEnabledRules(pools, new Set(['go_a']), (ref) => (ref === 'node_a' ? 'go_a' : '')), false);
  // 未推送/推送失败/Go 未接入任何 Provider：空集合与缺省访问器都必须保守交还。
  assert.equal(hasUnacceptedEnabledRules(pools, new Set(), null), true);
  assert.equal(hasUnacceptedEnabledRules(pools, null, null), true);
  // Go 只承接了另一个账号。
  assert.equal(hasUnacceptedEnabledRules(pools, new Set(['go_other']), (ref) => `go_${ref.replace('node_', '')}`), true);
  // 池里没有带生效规则的账号。
  assert.equal(hasUnacceptedEnabledRules({ codex: [{ accountRef: 'node_plain' }] }, new Set(), null), false);
  assert.equal(hasUnacceptedEnabledRules(null, new Set(), null), false);
});
