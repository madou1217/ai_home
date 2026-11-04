'use strict';

// `/` 筛选的三条约定：
//   1. `/` 进入输入态；输入态里 `q` 是字符（否则搜不了 qoder），Enter 保留查询，
//      Esc 清空并退出输入态，Ctrl+C 退出；
//   2. 普通模式下 `q` 退出；有筛选时 Esc 先清筛选，再按一次才退出；
//   3. 裁行按 provider 整块：只留下"至少有一个账号命中"的块，命中不到给一行提示。

const test = require('node:test');
const assert = require('node:assert/strict');

const { filterListRows } = require('../lib/cli/services/profile/list');
const { parseListKey, runAnimatedList } = require('../lib/cli/services/profile/account-list-animator');

function row(kind, text, meta = null) {
  return { kind, text, meta, render: (prefix = '') => `${prefix}${kind}:${text}` };
}

test('filterListRows：按 provider 整块保留，标题只在有块存活时保留', () => {
  const rows = [
    row('spacer', ''),
    row('title', 'overview'),
    row('spacer', ''),
    row('provider', 'codex'),
    row('account', 'codex 1 alpha'),
    row('provider', 'codebuddy'),
    row('account', 'codebuddy 1 buddy-user'),
    row('provider', 'workbuddy'),
    row('account', 'workbuddy 1 other')
  ];

  const buddy = filterListRows(rows, 'buddy');
  assert.deepEqual(buddy.map((r) => r.text), [
    '', 'overview', '',
    'codebuddy', 'codebuddy 1 buddy-user',
    'workbuddy', 'workbuddy 1 other'
  ]);

  // 大小写与首尾空格都不影响。
  assert.deepEqual(filterListRows(rows, '  ALPHA ').map((r) => r.text), [
    '', 'overview', '', 'codex', 'codex 1 alpha'
  ]);
});

test('filterListRows：空查询原样返回，没命中给一行提示', () => {
  const rows = [row('provider', 'codex'), row('account', 'codex 1')];
  assert.equal(filterListRows(rows, ''), rows);
  assert.equal(filterListRows(rows, '   '), rows);

  const miss = filterListRows(rows, 'zzz');
  assert.equal(miss.length, 1);
  assert.equal(miss[0].kind, 'notice');
  assert.match(miss[0].render(''), /No accounts match "zzz"/);
});

test('parseListKey：普通模式 / 进筛选，q 退出，Esc 走 escape', () => {
  assert.deepEqual(parseListKey('/'), { pending: false, action: 'filter-start', rest: '' });
  assert.deepEqual(parseListKey('q'), { pending: false, action: 'quit', rest: '' });
  assert.deepEqual(parseListKey('\x1b', { allowBareEscape: true }), { pending: false, action: 'escape', rest: '' });
  // 方向键仍要等后续字节，不能当成 Esc。
  assert.equal(parseListKey('\x1b[', {}).pending, true);
});

test('parseListKey：输入态里 q 是字符，Enter 保留，Esc 清空，Ctrl+C 退出', () => {
  const opts = { filtering: true, allowBareEscape: true };
  assert.deepEqual(parseListKey('q', opts), { pending: false, action: 'filter-append', char: 'q', rest: '' });
  assert.deepEqual(parseListKey('/', opts), { pending: false, action: 'filter-append', char: '/', rest: '' });
  assert.deepEqual(parseListKey('码', opts), { pending: false, action: 'filter-append', char: '码', rest: '' });
  assert.deepEqual(parseListKey('\r', opts), { pending: false, action: 'filter-done', rest: '' });
  assert.deepEqual(parseListKey('\x7f', opts), { pending: false, action: 'filter-backspace', rest: '' });
  assert.deepEqual(parseListKey('\x1b', opts), { pending: false, action: 'filter-cancel', rest: '' });
  assert.deepEqual(parseListKey('\x03', opts), { pending: false, action: 'quit', rest: '' });
});

function createInteractiveHarness(onFilterChange) {
  const writes = [];
  const listeners = {};
  const stdin = {
    isTTY: true,
    isRaw: false,
    setRawMode(mode) { this.isRaw = !!mode; },
    on(event, handler) { listeners[event] = handler; },
    off(event) { delete listeners[event]; },
    resume() {}
  };
  const processObj = {
    platform: 'linux',
    stdout: { isTTY: true, columns: 120, rows: 40, write: (chunk) => writes.push(String(chunk)) },
    stdin,
    on() {},
    off() {},
    exit() {}
  };
  const animator = runAnimatedList({
    lineCount: 1,
    renderLine: (prefix) => `${prefix}row`,
    readActivity: () => new Map(),
    activityOfRow: () => null,
    processObj,
    keepAlive: false,
    onFilterChange,
    refreshLines: () => 1
  });
  const state = { quit: 0 };
  animator.onQuit(() => { state.quit += 1; });
  return { animator, stdin, writes, state, send: (keys) => listeners.data(Buffer.from(keys, 'utf8')) };
}

test('动画：/ + 输入 + Enter 把查询词交给调用方，Esc 清空', async () => {
  const seen = [];
  const harness = createInteractiveHarness((query) => seen.push(query));
  try {
    harness.send('/');
    harness.send('b');
    harness.send('u');
    harness.send('d');
    harness.send('\r');
    assert.deepEqual(seen, ['b', 'bu', 'bud']);

    harness.send('\x1b');
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.deepEqual(seen, ['b', 'bu', 'bud', '']);
  } finally {
    harness.animator.stop();
  }
});

test('动画：普通模式 q 退出，有筛选时 Esc 先清筛选', async () => {
  const seen = [];
  const harness = createInteractiveHarness((query) => seen.push(query));
  try {
    harness.send('/');
    harness.send('x');
    harness.send('\r');
    harness.send('\x1b');
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.deepEqual(seen, ['x', ''], 'Esc 先清筛选，不退出');

    assert.equal(harness.state.quit, 0, 'Esc 清筛选不该退出');
    harness.send('q');
    assert.equal(harness.state.quit, 1, 'q 才是退出');
  } finally {
    harness.animator.stop();
  }
});

test('状态行：只有 stdin 可交互时才画（否则「按 q 退出」是假的）', () => {
  const writes = [];
  const processObj = {
    platform: 'linux',
    stdout: { isTTY: true, columns: 120, rows: 40, write: (chunk) => writes.push(String(chunk)) },
    // 只有 isTTY，没有 setRawMode/on：读不到按键。
    stdin: { isTTY: true },
    on() {},
    off() {},
    exit() {}
  };
  const animator = runAnimatedList({
    lineCount: 1,
    renderLine: (prefix) => `${prefix}row`,
    readActivity: () => new Map(),
    activityOfRow: () => null,
    processObj,
    keepAlive: false
  });
  try {
    const frame = writes.join('');
    assert.doesNotMatch(frame, /筛选/);
    assert.doesNotMatch(frame, /q\/Esc/);
  } finally {
    animator.stop();
  }
});

test('状态行：交互态先给按键提示，`/` 之后变成输入提示并回显查询词', () => {
  const harness = createInteractiveHarness(() => {});
  try {
    const initial = harness.writes.join('');
    assert.match(initial, /\/ 筛选/);
    assert.match(initial, /q\/Esc 退出/);

    harness.writes.length = 0;
    harness.send('/');
    harness.send('b');
    // 颜色码夹在 / 和查询词之间，比对前先剥掉。
    const editing = harness.writes.join('').replace(/\x1b\[[0-9;]*m/g, '');
    assert.match(editing, /Enter 保留/);
    assert.match(editing, /\/b/);
  } finally {
    harness.animator.stop();
  }
});
