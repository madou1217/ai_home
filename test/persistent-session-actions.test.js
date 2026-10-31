'use strict';

// 选中会话后的小命令：c 复制会话ID、y 复制进入命令、d 看详情。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  describePickerRow,
  parseSessionPickerKey,
  runPickerRowAction
} = require('../lib/cli/services/ai-cli/persistent-session-list');
const { copyText } = require('../lib/runtime/clipboard-copy');

const ROW = {
  live: true,
  cliName: 'claude',
  cliAccountId: '.aih-server',
  description: '✳ 本地合并取代 AWS',
  agentSessionId: '01a176a2-edbc-7ae2-b7d0-5d084d0c28fe',
  path: '/Users/model/projects/feature/ai_home',
  name: 'p-ai_home-1z0bk3-mvva10v9-19ug'
};

test('按键：c / y / d 映射到复制 ID / 复制命令 / 详情，旧按键不变', () => {
  assert.equal(parseSessionPickerKey('c').action, 'copy-id');
  assert.equal(parseSessionPickerKey('y').action, 'copy-command');
  assert.equal(parseSessionPickerKey('d').action, 'show-detail');
  assert.equal(parseSessionPickerKey('x').action, 'close-selected');
  assert.equal(parseSessionPickerKey('X').action, 'close-idle');
  assert.equal(parseSessionPickerKey('q').action, 'quit');
  assert.equal(parseSessionPickerKey('\u001b[A').action, 'up');
  assert.equal(parseSessionPickerKey('\r').action, 'enter');
});

test('c：把 harness 会话ID写进剪贴板，并给出提示', () => {
  const copied = [];
  const message = runPickerRowAction('copy-id', ROW, { copyText: (text) => { copied.push(text); return { ok: true }; } });
  assert.deepEqual(copied, ['01a176a2-edbc-7ae2-b7d0-5d084d0c28fe']);
  assert.match(message, /已复制会话ID/);
  assert.match(message, /01a176a2/);
});

test('y：有原生 id 复制 aih <cli> <账号> resume <id>，没有就复制 aih ss <名字>', () => {
  const copied = [];
  const copy = (text) => { copied.push(text); return { ok: true }; };
  runPickerRowAction('copy-command', ROW, { copyText: copy });
  assert.equal(copied[0], 'aih claude .aih-server resume 01a176a2-edbc-7ae2-b7d0-5d084d0c28fe');
  runPickerRowAction('copy-command', { ...ROW, agentSessionId: '' }, { copyText: copy });
  assert.equal(copied[1], 'aih ss p-ai_home-1z0bk3-mvva10v9-19ug');
});

test('d：详情包含 provider / 账号 / 路径 / id；剪贴板不可用时把内容打在提示里', () => {
  const detail = runPickerRowAction('show-detail', ROW, { copyText: () => ({ ok: true }) });
  assert.match(detail, /claude#\.aih-server/);
  assert.match(detail, /feature\/ai_home/);
  assert.match(detail, /01a176a2/);

  const failed = runPickerRowAction('copy-id', ROW, { copyText: () => ({ ok: false }) });
  assert.match(failed, /剪贴板不可用/);
  assert.match(failed, /01a176a2/);
});

test('describePickerRow：ID 用 harness 原生 id，tmux/pane 只出现在详情里', () => {
  const info = describePickerRow({ ...ROW, socket: 'aih-claude-acct_1' });
  assert.equal(info.id, ROW.agentSessionId);
  assert.match(info.command, /^aih claude .aih-server resume /);
  assert.match(info.detail, /feature\/ai_home/);
  assert.match(info.detail, /runtime tmux/);
  assert.match(info.detail, /socket aih-claude-acct_1/);
  assert.match(info.detail, /pane p-ai_home-1z0bk3-mvva10v9-19ug/);
  // 没有原生 id 时：会话ID 为空、命令退化为 aih ss <pane>
  const paneOnly = describePickerRow({ ...ROW, agentSessionId: '' });
  assert.equal(paneOnly.id, '');
  assert.match(paneOnly.command, /^aih ss p-ai_home/);
  assert.match(paneOnly.detail, /session 未识别/);
});

test('剪贴板：平台工具不可用时返回失败而不是抛错', () => {
  const result = copyText('x', { platform: 'linux', spawnSync: () => ({ status: 127 }) });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no_clipboard_tool');
  assert.equal(copyText('', {}).ok, false);
});

// --- 交互选择器：按键必须真的能退出（回归：q / Esc 不生效、连按 Esc 互相抵消） ---

const { EventEmitter } = require('node:events');
const { selectPersistentSessionRowAsync } = require('../lib/cli/services/ai-cli/persistent-session-list');

function makeFakeTerminal(columns = 120) {
  const stdin = new EventEmitter();
  stdin.isTTY = true;
  stdin.isRaw = false;
  stdin.fd = 0;
  stdin.setRawMode = (value) => { stdin.isRaw = !!value; };
  stdin.resume = () => {};
  stdin.pause = () => {};
  stdin.isPaused = () => false;
  const stdout = new EventEmitter();
  stdout.isTTY = true;
  stdout.columns = columns;
  stdout.frames = [];
  stdout.write = (text) => { stdout.frames.push(String(text)); return true; };
  const processImpl = new EventEmitter();
  processImpl.stdin = stdin;
  processImpl.stdout = stdout;
  processImpl.platform = 'darwin';
  processImpl.env = {};
  return { processImpl, stdin, stdout };
}

const ROWS = [
  { ...ROW, targetSession: ROW.name },
  { ...ROW, name: 'p-aih-2', targetSession: 'p-aih-2', live: false, agentSessionId: '01a176a2-0000-7ae2-b7d0-5d084d0c28ff' }
];

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

test('async picker：q 直接退出，并恢复终端（raw 模式关掉）', async () => {
  const { processImpl, stdin } = makeFakeTerminal();
  const done = selectPersistentSessionRowAsync(ROWS, {
    processImpl,
    refreshRows: () => ROWS,
    refreshIntervalMs: 10000,
    animationIntervalMs: 10000
  });
  await tick();
  assert.equal(stdin.isRaw, true, '打开时应该进 raw 模式');
  stdin.emit('data', Buffer.from('q'));
  assert.equal(await done, null);
  assert.equal(stdin.isRaw, false, '退出后必须恢复终端，否则 shell 会吃掉按键');
});

test('async picker：连按 Esc 也能退出（\x1b\x1b 不能互相抵消）', async () => {
  const { processImpl, stdin } = makeFakeTerminal();
  const done = selectPersistentSessionRowAsync(ROWS, {
    processImpl,
    refreshRows: () => ROWS,
    refreshIntervalMs: 10000,
    animationIntervalMs: 10000,
    escapeDelayMs: 80
  });
  await tick();
  stdin.emit('data', Buffer.from('\u001b'));
  stdin.emit('data', Buffer.from('\u001b'));
  assert.equal(await done, null);
});

test('async picker：单独 Esc 稍等后退出（不跟方向键抢）', async () => {
  const { processImpl, stdin } = makeFakeTerminal();
  const done = selectPersistentSessionRowAsync(ROWS, {
    processImpl,
    refreshRows: () => ROWS,
    refreshIntervalMs: 10000,
    animationIntervalMs: 10000,
    escapeDelayMs: 60
  });
  await tick();
  stdin.emit('data', Buffer.from('\u001b'));
  assert.equal(await done, null);
});

test('async picker：方向键选择 + Enter 返回选中行', async () => {
  const { processImpl, stdin } = makeFakeTerminal();
  const done = selectPersistentSessionRowAsync(ROWS, {
    processImpl,
    refreshRows: () => ROWS,
    refreshIntervalMs: 10000,
    animationIntervalMs: 10000
  });
  await tick();
  stdin.emit('data', Buffer.from('\u001b[B'));
  await tick(10);
  stdin.emit('data', Buffer.from('\r'));
  const selected = await done;
  assert.equal(selected && selected.targetSession, 'p-aih-2');
});

test('async picker：x 关闭会话（不再依赖已删除的粒子模块）', async () => {
  const { processImpl, stdin, stdout } = makeFakeTerminal();
  const closed = [];
  const done = selectPersistentSessionRowAsync(ROWS, {
    processImpl,
    refreshRows: () => ROWS,
    refreshIntervalMs: 10000,
    animationIntervalMs: 10000,
    closeSession: (row) => { closed.push(row && row.targetSession); return { ok: true }; }
  });
  await tick();
  stdin.emit('data', Buffer.from('x'));
  await tick(10);
  assert.deepEqual(closed, [ROW.name]);
  stdin.emit('data', Buffer.from('q'));
  assert.equal(await done, null);
  assert.match(stdout.frames.join(''), /关闭|已关闭/);
});

test('async picker：窗口缩放不崩，重新按新列宽渲染', async () => {
  const { processImpl, stdin, stdout } = makeFakeTerminal(120);
  const done = selectPersistentSessionRowAsync(ROWS, {
    processImpl,
    refreshRows: () => ROWS,
    refreshIntervalMs: 10000,
    animationIntervalMs: 10000
  });
  await tick();
  const before = stdout.frames.length;
  stdout.columns = 70;
  stdout.emit('resize');
  await tick(10);
  assert.ok(stdout.frames.length > before, '缩放后应该重画');
  stdin.emit('data', Buffer.from('q'));
  assert.equal(await done, null);
});


test('deriveSessionStatus：运行中 / 空闲 / 已结束 / 警告 与标题同源', () => {
  const { deriveSessionStatus } = require('../lib/cli/services/ai-cli/persistent-session-list');
  assert.equal(deriveSessionStatus({ live: true }).label, '运行中');
  assert.equal(deriveSessionStatus({ live: false }).label, '空闲');
  assert.equal(deriveSessionStatus({ live: false, paneDeadChecked: true, paneDead: true }).label, '已结束');
  assert.equal(deriveSessionStatus({ live: true, utf8RuntimeChecked: true, utf8RuntimeReady: false }).label, '警告');
  // 已结束/警告的行即使 pane 还活着也不能显示「运行中」
  assert.equal(deriveSessionStatus({ live: true, paneDeadChecked: true, paneDead: true }).label, '已结束');
});


test('c：没识别出 harness 会话ID 时给提示，不覆盖剪贴板', () => {
  const copied = [];
  const message = runPickerRowAction('copy-id', { ...ROW, agentSessionId: '' }, { copyText: (text) => { copied.push(text); return { ok: true }; } });
  assert.deepEqual(copied, []);
  assert.match(message, /没识别出 harness 会话ID/);
});
