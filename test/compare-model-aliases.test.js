'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { compareAliasesById, parseArgs } = require('../scripts/compare-model-aliases');

function record(overrides = {}) {
  return {
    id: 'a1',
    alias: 'fast',
    target: 'glm-5.3-flash',
    provider: 'all',
    targetProvider: 'auto',
    priority: 0,
    enabled: true,
    description: '',
    ...overrides
  };
}

test('完全一致时 equal', () => {
  const result = compareAliasesById([record()], [record()]);
  assert.equal(result.equal, true);
  assert.equal(result.nodeCount, 1);
  assert.equal(result.goCount, 1);
});

test('按 id 对齐：仅 Node 有 / 仅 Go 有 分开报', () => {
  const result = compareAliasesById([record({ id: 'a1' })], [record({ id: 'b1', alias: 'other' })]);
  assert.deepEqual(result.missing, [{ id: 'a1', alias: 'fast' }]);
  assert.deepEqual(result.extra, [{ id: 'b1', alias: 'other' }]);
  assert.equal(result.equal, false);
});

test('字段差异要指出具体字段', () => {
  const result = compareAliasesById(
    [record()],
    [record({ priority: 3, enabled: false })]
  );
  assert.equal(result.changed.length, 1);
  assert.deepEqual(result.changed[0].fields.sort(), ['enabled', 'priority']);
});

test('id 相同但别名不同也算字段差异', () => {
  const result = compareAliasesById([record()], [record({ alias: 'renamed' })]);
  assert.deepEqual(result.changed[0].fields, ['alias']);
});

test('空输入视为一致', () => {
  assert.equal(compareAliasesById([], []).equal, true);
});

test('parseArgs 拒绝未知参数并默认 JSON 关闭', () => {
  assert.throws(() => parseArgs(['--nope']), /未知参数/);
  assert.equal(parseArgs([]).json, false);
  assert.equal(parseArgs(['--json']).json, true);
});

