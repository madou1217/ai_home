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

const { runAnimatedList, toScreenLine } = require('../lib/cli/services/profile/account-list-animator');

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
    stdin: { isTTY: true },
    on() {},
    off() {},
    exit() {}
  };
  const state = { lines: initialLines.slice() };
  const animator = runAnimatedList({
    lineCount: state.lines.length,
    renderLine: (prefix, index) => `${prefix}${state.lines[index] || ''}`,
    readActivity: () => new Map(),
    activityOfRow: options.activityOfRow || (() => null),
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
  await sleep(2200);

  const delta = harness.writes.slice(before).join('');
  assert.ok(delta.length > 0, '内容变化后应重绘');
  assert.ok(!delta.includes('\x1b[H\x1b[J'), '增量更新不应清屏');
  assert.ok(!delta.includes('row-0'), '未变化的行不该被重写');
  assert.match(delta, /\x1b\[2;1H/, '变化行用绝对定位就地更新');
  // 特效播完后，最后落成的必须是干净的新文本。
  const frames = [...delta.matchAll(/\x1b\[2;1H([\s\S]*?)\x1b\[K/g)].map((match) => match[1]);
  assert.equal(frames[frames.length - 1], '  - row-1-updated');
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
  await sleep(2200);

  const delta = harness.writes.slice(before).join('');
  const frames = [...delta.matchAll(/\x1b\[4;1H([\s\S]*?)\x1b\[K/g)].map((match) => match[1]);
  assert.equal(frames[frames.length - 1], '  - row-8-visible');
  assert.ok(!delta.includes('row-0-offscreen'), '回滚区里的行不该重写');
  // scrolledOff = 10 - (6-1) = 5 → 列表第 9 行（0-based 8）落在屏幕第 4 行。
  assert.match(delta, /\x1b\[4;1H/);
  assert.ok(!delta.includes('\x1b[H\x1b[J'), '增量更新不应清屏');
  // 变化行会做多米诺特效（同一行重画几帧），但**不该碰别的行**。
  const touchedRows = new Set((delta.match(/\x1b\[(\d+);1H/g) || []).map((move) => move.replace(/\D/g, '')));
  assert.ok(touchedRows.size <= 2, `只应重画这一行（+ 光标归位），实际 ${[...touchedRows].join(',')}`);
});

test('变化行有多米诺特效：字符被逐个推倒，最后落成新文本', async (t) => {
  const harness = createHarness(['row-0', 'row-1-original-long-text', 'row-2']);
  t.after(() => harness.animator.stop());
  await sleep(120);

  const before = harness.writes.length;
  const updated = 'row-1-updated-content-after-refresh';
  harness.state.lines[1] = updated;
  await sleep(2200);

  const delta = harness.writes.slice(before).join('');
  // 抖动期间必须出现多米诺字符（| / \ 三态）。
  assert.match(delta, /[|/\\]/, '应出现多米诺字符');
  // 该行最终必须精确落成新文本，不能残留特效字符。
  const rowTexts = [...delta.matchAll(/\x1b\[2;1H([\s\S]*?)\x1b\[K/g)].map((match) => match[1]);
  assert.ok(rowTexts.length >= 2, `变化行应该有过渡帧，实际 ${rowTexts.length}`);
  assert.equal(rowTexts[rowTexts.length - 1], `  - ${updated}`, '最后一帧必须是干净的新文本');
  assert.ok(rowTexts.some((text) => text !== `  - ${updated}`), '中间帧应处于特效状态');
});

test('转圈前缀一直在变也不打断多米诺：波浪必须扫到行尾', async (t) => {
  // 复现 2026-11-04 真机 bug：账号在转圈时前缀每帧都变，旧实现把它当成"目标变了"，
  // 每帧重新起波 → 特效卡在行首几个字符。
  const harness = createHarness(['row-0', 'row-1-original-long-content-here', 'row-2'], {
    activityOfRow: () => ({ accountRef: 'acct_x', inFlight: 1, rate: 6 })
  });
  t.after(() => harness.animator.stop());
  await sleep(150);

  const before = harness.writes.length;
  const updated = 'row-1-updated-content-that-is-long-enough';
  harness.state.lines[1] = updated;
  await sleep(2600);

  const delta = harness.writes.slice(before).join('');
  const rowTexts = [...delta.matchAll(/\x1b\[2;1H([\s\S]*?)\x1b\[K/g)].map((match) => match[1]);
  assert.ok(rowTexts.length >= 3, `应该有多个过渡帧，实际 ${rowTexts.length}`);

  // 波浪位置（'/|' 出现的列）必须一路右移，而不是停在行首。
  const positions = rowTexts
    .map((text) => text.indexOf('/|'))
    .filter((position) => position >= 0);
  assert.ok(positions.length >= 3, `应该出现多帧波浪，实际 ${positions.length}`);
  assert.ok(Math.max(...positions) - Math.min(...positions) >= 10, `波浪应扫过整行，实际位置 ${positions.join(',')}`);
  assert.equal(rowTexts[rowTexts.length - 1].slice(4), updated, '最后一帧必须是干净的新文本');
});

test('stdin 不是 TTY 时不做动画（没人能退出 = 孤儿进程）', () => {
  const writes = [];
  const animator = runAnimatedList({
    lineCount: 2,
    renderLine: (prefix, index) => `${prefix}row-${index}`,
    readActivity: () => new Map(),
    activityOfRow: () => null,
    processObj: {
      platform: 'linux',
      stdout: { isTTY: true, columns: 80, rows: 20, write: (chunk) => writes.push(String(chunk)) },
      stdin: { isTTY: false },
      on() {}, off() {}, exit() {}
    },
    keepAlive: false
  });
  assert.equal(animator, null, 'stdin 非 TTY 必须返回 null（走一次性输出）');
  assert.equal(writes.length, 0);
});

test('终端挂断（SIGHUP）要正常收尾退出，不能留后台进程', () => {
  const handlers = new Map();
  let exited = false;
  const animator = runAnimatedList({
    lineCount: 2,
    renderLine: (prefix, index) => `${prefix}row-${index}`,
    readActivity: () => new Map(),
    activityOfRow: () => null,
    processObj: {
      platform: 'linux',
      stdout: { isTTY: true, columns: 80, rows: 20, write() {} },
      stdin: { isTTY: true },
      on: (name, handler) => handlers.set(name, handler),
      off: (name) => handlers.delete(name),
      exit() {}
    },
    keepAlive: false
  });
  animator.onQuit(() => { exited = true; });
  assert.equal(typeof handlers.get('SIGHUP'), 'function', '必须监听 SIGHUP');
  handlers.get('SIGHUP')();
  assert.equal(exited, true, 'SIGHUP 应触发退出回调');
  animator.stop();
});

test('每行必须单行化并截断：内嵌换行 / 超宽都会让绝对定位串行', () => {
  assert.equal(toScreenLine('a\nb', 80), 'a b');
  assert.equal(toScreenLine('a\r\nb', 80), 'a b');

  const long = 'x'.repeat(100);
  const cut = toScreenLine(long, 10).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  assert.equal(cut.length, 10, '超宽行必须截到终端宽度内');

  const colored = '\x1b[36m' + 'y'.repeat(50) + '\x1b[0m';
  const coloredCut = toScreenLine(colored, 8).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  assert.equal(coloredCut.length, 8, 'ANSI 不占宽度');
});
