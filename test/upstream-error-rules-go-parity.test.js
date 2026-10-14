'use strict';

// 账号自定义上游错误规则的跨实现一致性测试。
//
// Go（core/upstreamrules）与 Node（lib/account/upstream-error-rules.js）共享同一份
// 样例文件：Go 侧由 core/upstreamrules/match_test.go 断言，Node 侧由本文件断言。
// 任一侧语义漂移都会让另一侧失败——这是 Go 承接 account_error_rules 交还逻辑的
// 最低证据要求。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { matchUpstreamErrorRule, validateUpstreamErrorRules } = require('../lib/account/upstream-error-rules');

const FIXTURE_PATH = path.join(__dirname, '..', 'core', 'upstreamrules', 'testdata', 'parity_cases.json');

function loadCases() {
  const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
  assert.ok(Array.isArray(fixture.cases) && fixture.cases.length > 0, '一致性样例不能为空');
  return fixture.cases;
}

test('upstream error rule parity fixture matches Node matcher', () => {
  for (const testCase of loadCases()) {
    const rules = testCase.rules;
    const rule = matchUpstreamErrorRule(rules, testCase.statusCode, testCase.body);
    const index = rule ? rules.indexOf(rule) : -1;
    assert.equal(index, testCase.expectMatchedIndex, `${testCase.name}: 命中下标`);
    if (testCase.expectMatchedIndex < 0) continue;
    assert.equal(rule.kind, testCase.expectKind, `${testCase.name}: 命中状态`);
  }
});

test('upstream error rule parity fixture survives Node validation unchanged', () => {
  // 样例必须同时是 Node 的合法配置：否则它描述的语义在真实链路里根本不会被保存。
  for (const testCase of loadCases()) {
    const validated = validateUpstreamErrorRules(testCase.rules);
    assert.equal(validated.length, testCase.rules.length, `${testCase.name}: 规则条数`);
    for (const rule of validated) {
      assert.ok(rule.enabled === true || rule.enabled === false, `${testCase.name}: enabled 已归一化`);
      assert.ok(Array.isArray(rule.statuses), `${testCase.name}: statuses 已归一化`);
      assert.ok(rule.matchers.length > 0, `${testCase.name}: matchers 已归一化`);
    }
    const rule = matchUpstreamErrorRule(validated, testCase.statusCode, testCase.body);
    const index = rule ? validated.indexOf(rule) : -1;
    assert.equal(index, testCase.expectMatchedIndex, `${testCase.name}: 归一化后命中下标`);
  }
});
