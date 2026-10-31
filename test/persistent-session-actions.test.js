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
  stdin.resumed = 0;
  stdin.paused = 0;
  stdin.unrefed = 0;
  stdin.resume = () => { stdin.resumed += 1; };
  stdin.pause = () => { stdin.paused += 1; };
  stdin.unref = () => { stdin.unrefed += 1; };
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
  // 回归：只 off('data') 不解除引用 → 事件循环不空 → 进程不退（终端回熟模式，按键只回显）。
  assert.ok(stdin.paused >= 1, '退出时必须 pause stdin');
  assert.ok(stdin.unrefed >= 1, '退出时必须 unref stdin，否则 aih ss 永远不退');
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

// --- claude：pane 标题 ↔ 会话文件 ai-title ---

const os = require('node:os');
const nodeFs = require('node:fs');
const nodePath = require('node:path');
const { resolveAgentSessionIds } = require('../lib/cli/services/ai-cli/session-title-resolver');

function makeClaudeHome(projectPath, sessions) {
  const home = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'aih-claude-'));
  const dirName = String(projectPath).replace(/[^a-zA-Z0-9]/g, '-');
  const projectDir = nodePath.join(home, '.claude', 'projects', dirName);
  nodeFs.mkdirSync(projectDir, { recursive: true });
  for (const session of sessions) {
    const file = nodePath.join(projectDir, session.id + '.jsonl');
    const lines = [
      JSON.stringify({ type: 'mode' }),
      JSON.stringify({ type: 'ai-title', aiTitle: session.title, sessionId: session.id })
    ];
    nodeFs.writeFileSync(file, lines.join(String.fromCharCode(10)) + String.fromCharCode(10));
  }
  const stats = new Map(sessions.map((s) => [s.id, s]));
  return {
    home,
    projectDir,
    options: {
      hostHomeDir: home,
      statFile: (filePath) => {
        const id = nodePath.basename(filePath, '.jsonl');
        const session = stats.get(id) || {};
        const size = nodeFs.statSync(filePath).size;
        return {
          size,
          mtimeMs: Number(session.mtimeMs) || Date.now(),
          birthtimeMs: Number(session.startMs) || Number(session.mtimeMs) || Date.now()
        };
      }
    }
  };
}

const MINUTE = 60 * 1000;

test('claude：按 pane 标题绑到会话文件的 ai-title，取 pane 之后最早的那个', () => {
  const projectPath = '/Users/model/projects/demo';
  const createdSec = Math.floor((Date.now() - 3 * 60 * MINUTE) / 1000);
  const createdMs = createdSec * 1000;
  const { options } = makeClaudeHome(projectPath, [
    { id: 'aaa-111', title: '本地合并取代 AWS', startMs: createdMs + MINUTE },
    { id: 'bbb-222', title: '另一个标题', startMs: createdMs + 2 * MINUTE },
    // 同标题但更晚另开的会话：不能抢走上面那个 pane
    { id: 'ccc-333', title: '本地合并取代 AWS', startMs: createdMs + 60 * MINUTE }
  ]);
  const rows = [
    { name: 'p1', path: projectPath, title: '✳ 本地合并取代 AWS', created: createdSec },
    { name: 'p2', path: projectPath, title: '✳ 另一个标题', created: createdSec }
  ];
  const out = resolveAgentSessionIds('claude', rows, options);
  assert.equal(out[0].agentSessionId, 'aaa-111');
  assert.equal(out[1].agentSessionId, 'bbb-222');
  assert.equal(out[0].agentSessionIdSource, 'store');
});

test('claude：标题对不上就不乱认（保持空），已有 id 的也不覆盖', () => {
  const projectPath = '/Users/model/projects/demo2';
  const { options } = makeClaudeHome(projectPath, [
    { id: 'ddd-444', title: '真实标题', startMs: Date.now() }
  ]);
  const rows = [
    { name: 'p1', path: projectPath, title: '✳ 完全不同的标题' },
    { name: 'p2', path: projectPath, title: '✳ 真实标题', agentSessionId: 'keep-me' }
  ];
  const out = resolveAgentSessionIds('claude', rows, options);
  assert.equal(out[0].agentSessionId, undefined);
  assert.equal(out[1].agentSessionId, 'keep-me');
});

test('claude：ai-title 在文件末尾也能读到（大文件不整读）', () => {
  const projectPath = '/Users/model/projects/demo3';
  const home = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'aih-claude-'));
  const dirName = String(projectPath).replace(/[^a-zA-Z0-9]/g, '-');
  const projectDir = nodePath.join(home, '.claude', 'projects', dirName);
  nodeFs.mkdirSync(projectDir, { recursive: true });
  const file = nodePath.join(projectDir, 'eee-555.jsonl');
  const filler = JSON.stringify({ type: 'user', text: 'x'.repeat(2000) });
  const lines = [];
  for (let i = 0; i < 300; i += 1) lines.push(filler);
  lines.push(JSON.stringify({ type: 'ai-title', aiTitle: '末尾标题', sessionId: 'eee-555' }));
  nodeFs.writeFileSync(file, lines.join(String.fromCharCode(10)) + String.fromCharCode(10));
  const out = resolveAgentSessionIds('claude', [
    { name: 'p1', path: projectPath, title: '✳ 末尾标题' }
  ], { hostHomeDir: home });
  assert.equal(out[0].agentSessionId, 'eee-555');
});

