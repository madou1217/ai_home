'use strict';

// 账号级规则投影的契约：只收集账号自身规则 + 挂载组 id，绝不发送已拼装的有效规则。
// 有效规则由 Go 读取映射组表后计算；这里多发一份就会让同一组规则在 Go 侧应用两次。

const test = require('node:test');
const assert = require('node:assert/strict');

const { collectAccountUpstreamErrorRuleRecords } = require('../lib/server/upstream-error-rules-projection');

function rule(name, kind = 'rate_limited') {
  return {
    name,
    kind,
    enabled: true,
    statuses: [429],
    matchers: [{ source: 'body', operator: 'contains', value: name }]
  };
}

test('只收集账号自身规则与挂载组 id，保持数组顺序', () => {
  const accounts = [
    {
      accountRef: 'acct_0123456789abcdef0123',
      provider: 'codex',
      env: {
        AIH_UPSTREAM_ERROR_RULES: JSON.stringify([rule('own-a'), rule('own-b')]),
        AIH_UPSTREAM_ERROR_GROUP_IDS: JSON.stringify(['uem_second', 'uem_first'])
      },
      // 运行池里的有效规则不应被使用：它已经包含组规则。
      upstreamErrorRules: [rule('own-a'), rule('own-b'), rule('from-group')]
    }
  ];
  const collected = collectAccountUpstreamErrorRuleRecords(accounts);
  assert.equal(collected.records.length, 1);
  assert.deepEqual(collected.records[0].group_ids, ['uem_second', 'uem_first']);
  assert.deepEqual(collected.records[0].rules.map((item) => item.name), ['own-a', 'own-b']);
});

test('只有组挂载、没有自身规则的账号也要推送', () => {
  const collected = collectAccountUpstreamErrorRuleRecords([
    {
      accountRef: 'acct_ffffffffffffffffffff',
      provider: 'claude',
      env: { AIH_UPSTREAM_ERROR_GROUP_IDS: JSON.stringify(['uem_group']) }
    }
  ]);
  assert.equal(collected.records.length, 1);
  assert.deepEqual(collected.records[0].group_ids, ['uem_group']);
  assert.deepEqual(collected.records[0].rules, []);
});

test('没有账号级配置的账号不占记录', () => {
  const collected = collectAccountUpstreamErrorRuleRecords([
    {
      accountRef: 'acct_0123456789abcdef0123',
      provider: 'codex',
      env: {},
      upstreamErrorRules: [rule('effective-only')]
    }
  ]);
  assert.deepEqual(collected.records, []);
});

test('Go 引用无法解析或 Provider 缺失时跳过并给出原因', () => {
  const collected = collectAccountUpstreamErrorRuleRecords([
    {
      accountRef: 'acct_0123456789abcdef0123',
      provider: '',
      env: { AIH_UPSTREAM_ERROR_RULES: JSON.stringify([rule('own')]) }
    },
    {
      accountRef: 'acct_ffffffffffffffffffff',
      provider: 'codex',
      env: { AIH_UPSTREAM_ERROR_RULES: JSON.stringify([rule('own')]) }
    }
  ], { goRefFor: (ref) => (ref === 'acct_ffffffffffffffffffff' ? '' : ref) });
  assert.deepEqual(collected.records, []);
  assert.deepEqual(
    collected.skipped.map((item) => item.reason).sort(),
    ['provider_missing', 'unresolved_go_ref']
  );
});

test('两个 Node 引用映射到同一个 Go 账号时只保留一条', () => {
  const collected = collectAccountUpstreamErrorRuleRecords([
    {
      accountRef: 'acct_0123456789abcdef0123',
      provider: 'codex',
      env: { AIH_UPSTREAM_ERROR_RULES: JSON.stringify([rule('first')]) }
    },
    {
      accountRef: 'acct_ffffffffffffffffffff',
      provider: 'codex',
      env: { AIH_UPSTREAM_ERROR_RULES: JSON.stringify([rule('second')]) }
    }
  ], { goRefFor: () => 'acct_0123456789abcdef0123' });
  assert.equal(collected.records.length, 1);
  assert.deepEqual(collected.records[0].rules.map((item) => item.name), ['first']);
});
