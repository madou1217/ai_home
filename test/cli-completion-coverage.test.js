'use strict';

// 补全覆盖守卫：凡是"手能敲到"的位置都要有候选（或在设计上明确交给 shell）。
// 这个用例会把 command-tree 里声明的全部命令与子命令层过一遍，任何新增命令忘了配
// 声明（子命令/旗标）都会让它变红 —— 而不是等用户按 TAB 才发现是空的。

const test = require('node:test');
const assert = require('node:assert/strict');

const { audit, INTENTIONAL_EMPTY } = require('../scripts/audit-cli-completion');

test('没有"能敲到却没有候选"的位置', () => {
  const { rows, unexpected } = audit();
  assert.ok(rows.length >= 40, `审计的位置太少：${rows.length}`);
  assert.deepEqual(unexpected.map((row) => row.position), []);
});

test('设计上交给 shell 的位置保持为空（不要为了"全"去猜）', () => {
  assert.deepEqual([...INTENTIONAL_EMPTY].sort(), ['export', 'help', 'import', 'resume', 'ssh']);
});
