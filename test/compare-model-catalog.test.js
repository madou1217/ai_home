'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { difference, matchesAllowed, parseArgs } = require('../scripts/compare-model-catalog.js');

test('difference 只保留左侧独有项并排序', () => {
  const node = new Set(['b', 'a', 'shared']);
  const go = new Set(['shared', 'c']);
  assert.deepEqual(difference(node, go), ['a', 'b']);
  assert.deepEqual(difference(go, node), ['c']);
});

test('matchesAllowed 按前缀、不区分大小写匹配', () => {
  assert.equal(matchesAllowed('gemini-2.5-pro', ['gemini']), true);
  assert.equal(matchesAllowed('Gemini-Pro', ['gemini']), true);
  assert.equal(matchesAllowed('claude-sonnet', ['gemini']), false);
  // 空前缀列表不得当作「全部允许」：那会把判据变成永远通过。
  assert.equal(matchesAllowed('anything', []), false);
});

test('parseArgs 收集可重复的允许前缀', () => {
  const options = parseArgs(['--go', 'http://go.local', '--allow-node-only', 'gemini', '--allow-node-only', 'custom-']);
  assert.equal(options.go, 'http://go.local');
  assert.deepEqual(options.allow, ['gemini', 'custom-']);
  assert.equal(options.json, false);
});

test('parseArgs 拒绝未知参数而不是静默忽略', () => {
  assert.throws(() => parseArgs(['--nope']), /未知参数/);
});

