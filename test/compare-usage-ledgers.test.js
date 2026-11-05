'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { compareRows, parseArgs } = require('../scripts/compare-usage-ledgers.js');

test('两侧都有量且接近 → comparable', () => {
  const result = compareRows(
    [{ provider: 'codex', tokens: 1000, requests: 5 }],
    [{ provider: 'codex', tokens: 950, requests: 5 }],
    0.2
  );
  assert.equal(result.verdict, 'ledgers_comparable');
  assert.equal(result.rows[0].verdict, 'comparable');
  assert.equal(result.rows[0].delta, 0.05);
});

test('一边完全没有量 → node_only / go_only，不算分歧', () => {
  const result = compareRows(
    [{ provider: 'claude', tokens: 500, requests: 2 }],
    [{ provider: 'zcode', tokens: 300, requests: 1 }],
    0.2
  );
  const byProvider = Object.fromEntries(result.rows.map((row) => [row.provider, row]));
  assert.equal(byProvider.claude.verdict, 'node_only');
  assert.equal(byProvider.zcode.verdict, 'go_only');
  assert.equal(result.verdict, 'ledgers_comparable');
});

test('一边只有零头 → partial（迁移未接全），不是 diverged', () => {
  const result = compareRows(
    [{ provider: 'zcode', tokens: 76825509, requests: 100 }],
    [{ provider: 'zcode', tokens: 1084, requests: 1 }],
    0.2
  );
  assert.equal(result.rows[0].verdict, 'partial');
  assert.equal(result.verdict, 'ledgers_comparable');
});

test('两边量级相当但差异超容差 → diverged（口径真的不同）', () => {
  const result = compareRows(
    [{ provider: 'codex', tokens: 1000, requests: 5 }],
    [{ provider: 'codex', tokens: 600, requests: 5 }],
    0.2
  );
  assert.equal(result.rows[0].verdict, 'diverged');
  assert.equal(result.verdict, 'ledgers_diverged');
  assert.equal(result.diverged.length, 1);
});

test('空输入不报错', () => {
  const result = compareRows([], [], 0.2);
  assert.deepEqual(result.rows, []);
  assert.equal(result.verdict, 'ledgers_comparable');
});

test('parseArgs 拒绝未知参数，默认容差可覆盖', () => {
  assert.throws(() => parseArgs(['--nope']), /未知参数/);
  const options = parseArgs(['--days', '3', '--tolerance', '0.05']);
  assert.equal(options.days, 3);
  assert.equal(options.tolerance, 0.05);
  // 非法容差回落默认值，而不是把判据变成「永远通过」。
  assert.equal(parseArgs(['--tolerance', 'abc']).tolerance, 0.2);
});

