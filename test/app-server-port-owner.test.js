'use strict';

// 回归:关闭常驻 app-server 只关了 tmux 会话,app-server 本身在 macOS 上残留,
// 攥着线程写锁,网页恢复该会话报 "thread already has an active writer"。

const test = require('node:test');
const assert = require('node:assert/strict');

const { killAppServerPortOwner } = require('../lib/server/app-server-port-owner');

function fakeSpawn(commandsByPid, listening) {
  return (command, args) => {
    if (command === 'lsof') return { status: 0, stdout: listening.join('\n') + '\n' };
    if (command === 'ps') return { status: 0, stdout: commandsByPid[args[args.length - 1]] || '' };
    return { status: 1, stdout: '' };
  };
}

test('POSIX: ends a leftover codex app-server still listening on the port', () => {
  const killed = [];
  const result = killAppServerPortOwner(53883, {
    platform: 'darwin',
    spawnSync: fakeSpawn({ 92767: '/x/codex.aih-original app-server -c model_provider=aih --listen ws://127.0.0.1:53883' }, ['92767']),
    kill: (pid, signal) => killed.push([pid, signal])
  });
  assert.equal(result, true);
  assert.deepEqual(killed, [[92767, 'SIGTERM']]);
});

test('POSIX: leaves an unrelated process that reuses the port alone', () => {
  const killed = [];
  const result = killAppServerPortOwner(53883, {
    platform: 'linux',
    spawnSync: fakeSpawn({ 4242: 'python3 -m http.server 53883' }, ['4242']),
    kill: (pid) => killed.push(pid)
  });
  assert.equal(result, false);
  assert.deepEqual(killed, []);
});

test('Windows: keeps killing the listener found through netstat', () => {
  const calls = [];
  const result = killAppServerPortOwner(3503, {
    platform: 'win32',
    spawnSync: (command, args) => {
      calls.push([command, ...args]);
      if (command === 'netstat') return { status: 0, stdout: '  TCP    127.0.0.1:3503    0.0.0.0:0    LISTENING    31620\n' };
      return { status: 0 };
    }
  });
  assert.equal(result, true);
  assert.deepEqual(calls.at(-1), ['taskkill', '/PID', '31620', '/T', '/F']);
});

test('invalid ports are ignored', () => {
  assert.equal(killAppServerPortOwner(0, { platform: 'darwin', spawnSync: () => { throw new Error('should not run'); } }), false);
});
