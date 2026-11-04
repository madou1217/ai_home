'use strict';

// `aih ls` 的动画重绘约定：
//   - 整屏只清一次（第一帧）；之后只重写变化的行，绝不每帧清屏；
//   - 内容没变就不写，别拿 10 次/秒的整屏重画去制造屏闪；
//   - 列表比屏幕高时只更新可见行，不整屏重写。
//
// 2026-11-04 实测旧实现：6 秒 60 帧里 40 帧内容完全没变，却每次都 `\x1b[H\x1b[J`
// 重画整屏 —— 用户看到的就是持续屏闪。

const test = require('node:test');
const assert = require('node:assert/strict');

const { runAnimatedList } = require('../lib/cli/services/profile/account-list-animator');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createHarness(initialLines, options = {}) {
  const writes = [];
  const stdout = {
    isTTY: true,
    columns: 120,
    rows: Number(options.rows) > 0 ? Number(options.rows) : 40,
    write: (chunk) => { writes.push(String(chunk)); }
  };
  const processObj = {
    platform: 'linux',
    stdout,
    stdin: {},
    on() {},
    off() {},
    exit() {}
  };
  const state = { lines: initialLines.slice() };
  const animator = runAnimatedList({
    lineCount: state.lines.length,
    renderLine: (prefix, index) => `${prefix}${state.lines[index] || ''}`,
    readActivity: () => new Map(),
    activityOfRow: () => null,
    processObj,
    keepAlive: false,
    refreshLines: options.refreshLines ? () => options.refreshLines(state) : null,
    refreshIntervalMs: options.refreshIntervalMs
  });
  return {
    writes,
    state,
    animator,
    text: () => writes.join('')
  };
}

test('首帧之后不再整屏清屏，内容没变就不写', async (t) => {
  const harness = createHarness(['row-0', 'row-1', 'row-2']);
  t.after(() => harness.animator.stop());

  assert.equal(harness.text().split('\x1b[H\x1b[J').length - 1, 1, '首帧只清一次屏');
  assert.match(harness.text(), /row-0/);

  const painted = harness.writes.length;
  await sleep(350);
  assert.equal(harness.writes.length, painted, '没有变化时不该有任何重绘');
});

test('只重写变化的行：不整屏清，也不动未变化的行', async (t) => {
  const harness = createHarness(['row-0', 'row-1', 'row-2']);
  t.after(() => harness.animator.stop());
  await sleep(120);

  const before = harness.writes.length;
  harness.state.lines[1] = 'row-1-updated';
  await sleep(350);

  const delta = harness.writes.slice(before).join('');
  assert.ok(delta.length > 0, '内容变化后应重绘');
  assert.match(delta, /row-1-updated/);
  assert.ok(!delta.includes('\x1b[H\x1b[J'), '增量更新不应清屏');
  assert.ok(!delta.includes('row-0'), '未变化的行不该被重写');
  assert.match(delta, /\x1b\[2;1H/, '变化行用绝对定位就地更新');
});

test('行数变化时重写全部行，但不做整屏清', async (t) => {
  const harness = createHarness(['row-0', 'row-1', 'row-2'], {
    refreshIntervalMs: 300,
    refreshLines: (state) => {
      if (state.lines.length === 3) state.lines.push('row-3');
      return state.lines.length;
    }
  });
  t.after(() => harness.animator.stop());

  await sleep(500);
  const text = harness.text();
  assert.equal(text.split('\x1b[H\x1b[J').length - 1, 1, '行数变化也不清屏');
  assert.match(text, /row-3/);

  const before = harness.writes.length;
  await sleep(350);
  assert.equal(harness.writes.length, before, '稳定之后同样不再重绘');
});

test('列表比屏幕高时只更新可见行，不整屏重写', async (t) => {
  const lines = Array.from({ length: 10 }, (_value, index) => `row-${index}`);
  const harness = createHarness(lines, { rows: 6 });
  t.after(() => harness.animator.stop());
  await sleep(120);

  const before = harness.writes.length;
  // 第 1 行已滚进回滚缓冲区（改不到），第 9 行还在屏幕上。
  harness.state.lines[0] = 'row-0-offscreen';
  harness.state.lines[8] = 'row-8-visible';
  await sleep(350);

  const delta = harness.writes.slice(before).join('');
  assert.match(delta, /row-8-visible/);
  assert.ok(!delta.includes('row-0-offscreen'), '回滚区里的行不该重写');
  // scrolledOff = 10 - (6-1) = 5 → 列表第 9 行（0-based 8）落在屏幕第 4 行。
  assert.match(delta, /\x1b\[4;1H/);
  assert.ok(!delta.includes('\x1b[H\x1b[J'), '增量更新不应清屏');
  const rowMoves = (delta.match(/\x1b\[\d+;1H/g) || []).length;
  assert.ok(rowMoves <= 3, `只应重写很少的行，实际 ${rowMoves}`);
});
