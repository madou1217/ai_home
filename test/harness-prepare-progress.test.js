'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const {
  createHarnessPrepareProgress
} = require('../lib/cli/services/ai-cli/harness-prepare-progress');

function createProcessStub({ isTTY = true } = {}) {
  const errorWrites = [];
  const stdoutWrites = [];
  const stderr = new EventEmitter();
  stderr.write = (chunk) => { errorWrites.push(String(chunk || '')); };
  if (isTTY) stderr.isTTY = true;
  const stdout = new EventEmitter();
  stdout.write = (chunk) => { stdoutWrites.push(String(chunk || '')); };
  return { processObj: { stderr, stdout, platform: 'darwin', env: {} }, errorWrites, stdoutWrites };
}

test('harness 安装阶段画一行 stderr 动画，结束时换成结果', () => {
  const { processObj, errorWrites, stdoutWrites } = createProcessStub();
  const report = createHarnessPrepareProgress({ processObj });

  report({ phase: 'install:start', harness: 'dsh-tui', label: '安装 dsh-tui profile bundle' });
  assert.match(errorWrites.join(''), /安装 dsh-tui profile bundle/);

  report({ phase: 'install:end', harness: 'dsh-tui', ok: true, durationMs: 18000 });
  const rendered = errorWrites.join('');
  assert.match(rendered, /✔/);
  assert.match(rendered, /已安装/);
  // stdout 留给 harness 自己，进度只走 stderr。
  assert.deepEqual(stdoutWrites, []);
});

test('安装失败收尾为 ✖，未知阶段与缺失的 end 都不写任何东西', () => {
  const { processObj, errorWrites } = createProcessStub();
  const report = createHarnessPrepareProgress({ processObj });

  report({ phase: 'whatever' });
  report({ phase: 'install:end', ok: true });
  assert.equal(errorWrites.length, 0);

  report({ phase: 'install:start', label: '' });
  report({ phase: 'install:end', ok: false });
  const rendered = errorWrites.join('');
  assert.match(rendered, /✖/);
  assert.match(rendered, /安装失败/);
  // 没有 label 时用兜底文案，不画一行空白动画。
  assert.match(rendered, /准备运行环境/);
});

test('重复的 install:start 只保留一行动画', () => {
  const { processObj, errorWrites } = createProcessStub();
  const report = createHarnessPrepareProgress({ processObj });

  report({ phase: 'install:start', label: '第一次' });
  report({ phase: 'install:start', label: '第二次' });
  report({ phase: 'install:end', ok: true });
  const rendered = errorWrites.join('');
  assert.match(rendered, /重新开始/);
  assert.match(rendered, /第二次/);
  assert.match(rendered, /已安装/);
});
