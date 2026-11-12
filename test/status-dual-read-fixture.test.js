'use strict';

// 夹具漂移守卫：testdata/status-dual-read.json 是 Node 真实行为的冻结快照。
// Node 侧任何状态转移改动都会让「重新生成」与「已提交的夹具」不一致——这个用例先红，
// 提醒你重新生成夹具并检查 Go 侧双读测试的差异，而不是让夹具悄悄过期。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const { build, serialize, FIXTURE_PATH } = require('../scripts/status-dual-read-capture');

test('status-dual-read 夹具与 Node 行为一致', () => {
  const expected = serialize(build());
  const current = fs.readFileSync(FIXTURE_PATH, 'utf8');
  assert.equal(
    current === expected,
    true,
    '夹具已过期：运行 node scripts/status-dual-read-capture.js 重新生成并提交'
  );
});

test('夹具覆盖失败/清除/整份替换三类事件', () => {
  const document = build();
  const ops = new Set();
  for (const entry of document.cases) {
    for (const step of entry.steps) ops.add(step.op);
    assert.equal(entry.expected.afterEach.length, entry.steps.length);
  }
  assert.deepEqual([...ops].sort(), ['clear', 'failure', 'runtime_state']);
});
