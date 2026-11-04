'use strict';

// ls 的屏幕级回归：把动画器写出的字节流按终端规则回放，断言**最终屏幕**和要渲染的
// 行逐行一致。只测"写了什么"不够——增量重绘用绝对行号定位，一旦某行折行或带内嵌
// 换行，后续行会整体串位（2026-11-04 真机：codebuddy 系列账号跑到 kiro 分组下面、
// kiro 账号重复出现）。这个用例专门守这类"内容对、位置错"的事故。

const test = require('node:test');
const assert = require('node:assert/strict');

const { runAnimatedList } = require('../lib/cli/services/profile/account-list-animator');

/** 极简终端：只实现这几种序列，够回放 ls 的输出。 */
function createScreen(columns = 60, rows = 40) {
  const lines = [];
  let row = 0;
  let col = 0;
  let pending = '';

  function put(ch) {
    while (lines.length <= row) lines.push('');
    const line = lines[row];
    if (col > line.length) lines[row] = line + ' '.repeat(col - line.length);
    const current = lines[row];
    lines[row] = current.slice(0, col) + ch + current.slice(col + 1);
    col += 1;
  }

  function feed(chunk) {
    const text = pending + String(chunk);
    pending = '';
    let i = 0;
    while (i < text.length) {
      const ch = text[i];
      if (ch === '\x1b') {
        const match = /^\x1b\[([0-9;?]*)([A-Za-z])/.exec(text.slice(i));
        if (!match) {
          // 序列被切断：留到下一块。
          if (i === text.length - 1 || /^\x1b\[[0-9;?]*$/.test(text.slice(i))) { pending = text.slice(i); return; }
          i += 1;
          continue;
        }
        const params = match[1];
        const final = match[2];
        i += match[0].length;
        if (final === 'H') {
          const parts = params.split(';');
          row = Math.max(0, (Number(parts[0]) || 1) - 1);
          col = Math.max(0, (Number(parts[1]) || 1) - 1);
        } else if (final === 'J') {
          if (row === 0 && col === 0) lines.length = 0;
          else if (row < lines.length) lines[row] = lines[row].slice(0, col);
          if (row < lines.length) lines.length = row + 1;
        } else if (final === 'K') {
          while (lines.length <= row) lines.push('');
          lines[row] = lines[row].slice(0, col);
        }
        continue;
      }
      if (ch === '\r') { col = 0; i += 1; continue; }
      if (ch === '\n') {
        row += 1;
        col = 0;
        i += 1;
        continue;
      }
      put(ch);
      i += 1;
    }
  }

  return {
    feed,
    snapshot: () => lines.map((line) => line.replace(/\s+$/, ''))
  };
}

function createHarness(lines, options = {}) {
  const writes = [];
  const stdout = {
    isTTY: true,
    columns: options.columns || 60,
    rows: options.rows || 40,
    write: (chunk) => writes.push(String(chunk))
  };
  const processObj = { platform: 'linux', stdout, stdin: {}, on() {}, off() {}, exit() {} };
  const state = { lines: lines.slice() };
  const animator = runAnimatedList({
    lineCount: state.lines.length,
    renderLine: (prefix, index) => `${prefix}${state.lines[index] || ''}`,
    readActivity: () => new Map(),
    activityOfRow: options.activityOfRow || (() => null),
    processObj,
    keepAlive: false
  });
  const screen = createScreen(stdout.columns, stdout.rows);
  writes.forEach((chunk) => screen.feed(chunk));
  return { writes, state, animator, screen };
}

function renderExpectation(lines) {
  return lines.map((line) => `  - ${line}`.replace(/\s+$/, ''));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('多 provider 列表：屏幕行序与模型完全一致（标题不串位、账号不重复）', async (t) => {
  const lines = [
    '',
    '📦 AI Home Accounts Overview',
    '',
    '▶ kiro',
    'Account ID: 2 (Kiro) [Remaining: 100.0%]',
    'Account ID: 3 (Kiro) [Remaining: 100.0%]',
    '▶ zcode',
    'Account ID: 5 (zcode phone) [Remaining: 83.0%]',
    'Account ID: 1 (zcode email) [Remaining: 100.0%]',
    '▶ codebuddy',
    'Account ID: 1 (cb) [Remaining: Credits: 100.0%]'
  ];
  const harness = createHarness(lines);
  t.after(() => harness.animator.stop());

  assert.deepEqual(harness.screen.snapshot(), renderExpectation(lines));
});

test('长行超出终端宽度：截断而不是折行（折行会让后续行整体串位）', async (t) => {
  const lines = [
    '▶ kiro',
    'Account ID: 4 (Kiro (Google)) ' + 'x'.repeat(120),
    '▶ codebuddy',
    'Account ID: 1 (cb) [Remaining: 100.0%]'
  ];
  const harness = createHarness(lines, { columns: 50 });
  t.after(() => harness.animator.stop());

  const snapshot = harness.screen.snapshot();
  assert.equal(snapshot.length, renderExpectation(lines).length, `屏幕行数必须等于列表行数，实际 ${snapshot.length}`);
  assert.match(snapshot[0], /▶ kiro/);
  assert.match(snapshot[2], /▶ codebuddy/, '被截断的行不能把后面的行挤走');
  assert.ok(snapshot[1].length <= 49, `超宽行应截到终端宽度内，实际 ${snapshot[1].length}`);
});

test('行里混进内嵌换行（旧版标题格式）：压成一行而不是把后面整体挤走', async (t) => {
  const lines = [
    '',
    '\n📦 AI Home Accounts Overview\n',
    '▶ kiro',
    'Account ID: 2 (Kiro) [Remaining: 100.0%]'
  ];
  const harness = createHarness(lines);
  t.after(() => harness.animator.stop());

  const snapshot = harness.screen.snapshot();
  assert.equal(snapshot.length, 4, `内嵌换行必须被压平，实际屏幕 ${snapshot.length} 行`);
  assert.match(snapshot[1], /📦 AI Home Accounts Overview/);
  assert.match(snapshot[2], /▶ kiro/);
  assert.match(snapshot[3], /Account ID: 2/);
});

test('运行中更新某行：屏幕仍然逐行对齐，不产生重复行', async (t) => {
  const lines = [
    '▶ kiro',
    'Account ID: 2 (Kiro) [Remaining: 100.0%]',
    '▶ codebuddy',
    'Account ID: 1 (cb) [Remaining: Credits: 100.0%]'
  ];
  const harness = createHarness(lines);
  t.after(() => harness.animator.stop());

  const before = harness.writes.length;
  harness.state.lines[3] = 'Account ID: 1 (cb) [Remaining: 91.0%]';
  await sleep(900);
  harness.writes.slice(before).forEach((chunk) => harness.screen.feed(chunk));

  const expected = renderExpectation(harness.state.lines);
  assert.deepEqual(harness.screen.snapshot(), expected);
});
