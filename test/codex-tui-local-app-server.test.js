'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { terminateChild } = require('../lib/server/codex-tui-local-app-server');

test('terminateChild kills the POSIX process group and escalates when it stays alive', async () => {
  const signals = [];
  const processObj = {
    kill(target, signal) { signals.push([target, signal]); }
  };
  const child = {
    pid: 1234,
    exitCode: null,
    kill(signal) { signals.push(['child', signal]); }
  };

  terminateChild(child, { platform: 'linux', processObj, processGroup: true, killGraceMs: 0 });
  assert.deepEqual(signals[0], [-1234, 'SIGTERM']);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(signals[1], [-1234, 'SIGKILL']);
});

test('terminateChild uses taskkill for Windows process trees', () => {
  const calls = [];
  const child = { pid: 5678, exitCode: null, kill() { calls.push('child'); } };
  terminateChild(child, {
    platform: 'win32',
    spawnSync(command, args) { calls.push([command, args]); return { status: 0 }; }
  });
  assert.deepEqual(calls, [['taskkill', ['/PID', '5678', '/T', '/F']]]);
});
