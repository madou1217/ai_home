'use strict';

// tmux server 非正常退出会留下永久失效的 socket 文件（真机实测堆了 1000+ 个）。
// 清理必须是"只删确认死了、且够老"的：活的 server、刚启动的 server 一律不动。

const test = require('node:test');
const assert = require('node:assert/strict');

const { pruneStaleTmuxSockets } = require('../lib/runtime/tmux-socket-prune');

const NOW = 1_800_000_000_000;
const OLD = NOW - 10 * 60 * 1000;
const YOUNG = NOW - 5 * 1000;

function fakeNet(alivePaths) {
  return {
    connect: ({ path }) => {
      const handlers = {};
      const socket = {
        once: (event, handler) => { (handlers[event] = handlers[event] || []).push(handler); },
        setTimeout: (_ms, handler) => { handlers.timeout = handler; },
        destroy: () => {},
        _flush: () => {
          const event = alivePaths.has(path) ? 'connect' : 'error';
          (handlers[event] || []).forEach((handler) => handler());
        }
      };
      setImmediate(() => socket._flush());
      return socket;
    }
  };
}

test('只删"连不上且够老"的 socket；活的、太新的、普通文件都不动', async () => {
  const entries = {
    '/tmp/tmux-1/alive': { socket: true, mtimeMs: OLD },
    '/tmp/tmux-1/dead-old': { socket: true, mtimeMs: OLD },
    '/tmp/tmux-1/dead-young': { socket: true, mtimeMs: YOUNG },
    '/tmp/tmux-1/not-a-socket': { socket: false, mtimeMs: OLD }
  };
  const removed = [];
  const fs = {
    readdirSync: () => Object.keys(entries).map((p) => p.split('/').pop()),
    lstatSync: (path) => {
      const entry = entries[path];
      return { isSocket: () => entry.socket, mtimeMs: entry.mtimeMs };
    },
    unlinkSync: (path) => { removed.push(path.split('/').pop()); }
  };
  const net = fakeNet(new Set(['/tmp/tmux-1/alive']));

  const summary = await pruneStaleTmuxSockets({
    fs,
    net,
    dir: '/tmp/tmux-1',
    nowMs: NOW,
    minAgeMs: 60 * 1000,
    timeoutMs: 20
  });

  assert.deepEqual(removed, ['dead-old']);
  assert.equal(summary.scanned, 3, '只统计 socket 文件');
  assert.equal(summary.removed, 1);
  assert.equal(summary.kept, 2);
});

test('目录不存在 / 没有 uid 时安静跳过', async () => {
  const fs = { readdirSync: () => { throw new Error('ENOENT'); } };
  assert.deepEqual(await pruneStaleTmuxSockets({ fs, dir: '/nope' }), {
    scanned: 0, removed: 0, kept: 0, skipped: 1
  });
  assert.deepEqual(await pruneStaleTmuxSockets({ fs, dir: '' }), {
    scanned: 0, removed: 0, kept: 0, skipped: 1
  });
});
