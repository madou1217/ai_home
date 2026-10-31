'use strict';

// 关闭会话时的"粒子消散"：只覆盖当前行，播完才真正关闭；非 TTY 直接跳过。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  selectPersistentSessionRow,
  selectPersistentSessionRowAsync,
  shouldAnimatePicker
} = require('../lib/cli/services/ai-cli/persistent-session-list');
const { dissolveFrame, dissolveFrames, displayWidth } = require('../lib/cli/services/ai-cli/particle-dissolve');

function makeRows() {
  return [
    { name: 'p-1', targetSession: 'p-1', live: true, cliName: 'claude', cliAccountId: '1', description: 'A', path: '/repo' },
    { name: 'p-2', targetSession: 'p-2', live: true, cliName: 'codex', cliAccountId: '2', description: 'B', path: '/repo' }
  ];
}

function makeProcess() {
  const out = [];
  return {
    out,
    processImpl: {
      platform: 'darwin',
      env: { TERM: 'xterm-256color' },
      stdout: { isTTY: true, columns: 100, write: (text) => out.push(String(text)) },
      stdin: {
        isTTY: true,
        isRaw: false,
        setRawMode() {},
        resume() {},
        pause() {},
        isPaused: () => false
      }
    }
  };
}

test('粒子帧：宽度不变，粒子逐步替代字符', () => {
  const line = '❯ ●  claude  #1  ✳ 本地合并取代 AWS';
  const frames = dissolveFrames(line, { frames: 5 });
  assert.equal(frames.length, 5);
  const width = displayWidth(line);
  for (const frame of frames) assert.equal(displayWidth(frame), width);
  const last = frames[frames.length - 1];
  assert.ok(!last.includes('本'));
});

test('动画开关：非 TTY / TERM=dumb / 显式关闭都不播', () => {
  assert.equal(shouldAnimatePicker({ stdout: { isTTY: true }, env: { TERM: 'xterm' } }), true);
  assert.equal(shouldAnimatePicker({ stdout: { isTTY: false }, env: { TERM: 'xterm' } }), false);
  assert.equal(shouldAnimatePicker({ stdout: { isTTY: true }, env: { TERM: 'dumb' } }), false);
  assert.equal(shouldAnimatePicker({ stdout: { isTTY: true }, env: { TERM: 'xterm' } }, { animation: false }), false);
});

test('按 x 关闭：先播动画再关闭；按 q 退出', () => {
  const { out, processImpl } = makeProcess();
  const closed = [];
  const keys = ['x', 'q'];
  let index = 0;
  const selected = selectPersistentSessionRow(makeRows(), {
    processImpl,
    fs: { readSync: () => 0 },
    readKey: () => (index < keys.length ? keys[index++] : ''),
    refreshRows: () => makeRows(),
    closeSession: (row) => { closed.push(row.name); return { ok: true }; },
    animation: true,
    homeDir: '/Users/model'
  });

  assert.equal(selected, null);
  assert.deepEqual(closed, ['p-1']);
  const plain = out.join('');
  assert.match(plain, /❯/);
  // 至少出现一次粒子字符（动画确实画了）
  assert.match(plain, /[·˙∙✦✧⁺˚]/);
});

test('关闭时不播动画的降级路径仍然工作', () => {
  const { processImpl } = makeProcess();
  const closed = [];
  const keys = ['x', 'q'];
  let index = 0;
  selectPersistentSessionRow(makeRows(), {
    processImpl,
    fs: { readSync: () => 0 },
    readKey: () => (index < keys.length ? keys[index++] : ''),
    refreshRows: () => makeRows(),
    closeSession: (row) => { closed.push(row.name); return { ok: true }; },
    animation: false,
    homeDir: '/Users/model'
  });
  assert.deepEqual(closed, ['p-1']);
});

test('dissolveFrame 不抛错（空串/超长）', () => {
  assert.equal(dissolveFrame('', 2, 5), '');
  const long = 'x'.repeat(500);
  assert.equal(displayWidth(dissolveFrame(long, 1, 5)), 500);
});

test('async picker（macOS 默认路径）：按 x 会播粒子动画再关闭', async () => {
  const { EventEmitter } = require('node:events');
  const out = [];
  const stdin = new EventEmitter();
  stdin.isTTY = true;
  stdin.isRaw = false;
  stdin.setRawMode = () => {};
  stdin.resume = () => {};
  stdin.pause = () => {};
  stdin.isPaused = () => false;
  const processImpl = {
    platform: 'darwin',
    env: { TERM: 'xterm-256color' },
    stdout: { isTTY: true, columns: 100, write: (text) => out.push(String(text)) },
    stdin
  };
  const closed = [];
  const promise = selectPersistentSessionRowAsync(makeRows(), {
    processImpl,
    refreshRows: () => makeRows(),
    closeSession: (row) => { closed.push(row.name); return { ok: true }; },
    homeDir: '/Users/model',
    animation: true,
    sessionPickerRefreshIntervalMs: 100000
  });
  setTimeout(() => stdin.emit('data', 'x'), 60);
  setTimeout(() => stdin.emit('data', 'q'), 900);
  const selected = await promise;
  assert.equal(selected, null);
  assert.deepEqual(closed, ['p-1']);
  assert.match(out.join(''), /[·˙∙✦✧⁺˚]/);
});
