'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { compareAliasSets, aliasKey } = require('../lib/server/model-alias-shadow');

test('两侧一致时 equal', () => {
  const node = [{ alias: 'fast', target: 'glm-5.3-flash', provider: 'zcode', priority: 1, enabled: true }];
  const go = [{ alias: 'fast', target: 'glm-5.3-flash', provider: 'zcode', priority: 1, enabled: true }];
  const diff = compareAliasSets(node, go);
  assert.equal(diff.equal, true);
  assert.deepEqual(diff.missing, []);
  assert.deepEqual(diff.extra, []);
  assert.deepEqual(diff.changed, []);
});

test('只在 Node 有 / 只在 Go 有要分开报', () => {
  const diff = compareAliasSets(
    [{ alias: 'a', target: 'x' }],
    [{ alias: 'b', target: 'y' }]
  );
  assert.deepEqual(diff.missing, ['a']);
  assert.deepEqual(diff.extra, ['b']);
  assert.equal(diff.equal, false);
});

test('字段差异要指出是哪几个字段', () => {
  const diff = compareAliasSets(
    [{ alias: 'a', target: 'x', priority: 1 }],
    [{ alias: 'a', target: 'x', priority: 2, description: 'new' }]
  );
  assert.equal(diff.changed.length, 1);
  assert.deepEqual(diff.changed[0].fields.sort(), ['description', 'priority']);
});

test('enabled 未声明等价于启用，不算差异', () => {
  const diff = compareAliasSets(
    [{ alias: 'a', target: 'x' }],
    [{ alias: 'a', target: 'x', enabled: true }]
  );
  assert.equal(diff.equal, true);
});

test('同名不同作用域是两条记录，不能互相覆盖', () => {
  const node = [
    { alias: 'fast', target: 'x', provider: 'codex' },
    { alias: 'fast', target: 'y', provider: 'claude' }
  ];
  const go = [
    { alias: 'fast', target: 'x', provider: 'codex' },
    { alias: 'fast', target: 'y', provider: 'claude' }
  ];
  assert.equal(compareAliasSets(node, go).equal, true);
  assert.notEqual(aliasKey(node[0]), aliasKey(node[1]));

  // 只有一边缺了 claude 作用域那条，必须报出来。
  const diff = compareAliasSets(node, [go[0]]);
  assert.deepEqual(diff.missing, ['fast']);
  assert.equal(diff.equal, false);
});

test('provider 缺失按 all 处理', () => {
  const diff = compareAliasSets(
    [{ alias: 'a', target: 'x' }],
    [{ alias: 'a', target: 'x', provider: 'all' }]
  );
  assert.equal(diff.equal, true);
});

test('空输入视为一致', () => {
  assert.equal(compareAliasSets([], []).equal, true);
  assert.equal(compareAliasSets(null, undefined).equal, true);
});

