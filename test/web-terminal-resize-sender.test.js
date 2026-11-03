'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('../web/node_modules/typescript');

const source = fs.readFileSync(require.resolve('../web/src/components/chat/terminal-resize-sender.ts'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
function fixture(send) {
  let now = 0;
  let nextId = 0;
  const timers = new Map();
  const loaded = { exports: {} };
  vm.runInNewContext(compiled, {
    module: loaded, exports: loaded.exports,
    Date: { now: () => now },
    setTimeout: (fn, delay) => { const id = ++nextId; timers.set(id, { fn, due: now + delay }); return id; },
    clearTimeout: (id) => timers.delete(id)
  });
  return {
    sender: loaded.exports.createTerminalResizeSender(send, 60),
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) if (timer.due <= now) { timers.delete(id); timer.fn(); }
    },
  };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('slow PTY resize requests are serialized and the latest size wins', async () => {
  const calls = [];
  const releases = [];
  const { sender, advance } = fixture((...args) => { calls.push(args); return new Promise((resolve) => releases.push(resolve)); });
  sender.enqueue('one', 80, 24);
  await tick();
  sender.enqueue('one', 90, 25);
  sender.enqueue('one', 100, 30);
  advance(200);
  assert.deepEqual(calls, [['one', 80, 24]]);
  releases.shift()();
  await tick();
  assert.deepEqual(calls, [['one', 80, 24], ['one', 100, 30]]);
  releases.shift()();
  await tick();
});

test('rapid resizes are paced and pending work is cancelled on dispose', async () => {
  const calls = [];
  const { sender, advance } = fixture(async (...args) => { calls.push(args); });
  sender.enqueue('one', 80, 24);
  await tick();
  sender.enqueue('one', 90, 25);
  sender.enqueue('two', 120, 40);
  advance(59);
  await tick();
  assert.equal(calls.length, 1);
  advance(1);
  await tick();
  assert.deepEqual(calls, [['one', 80, 24], ['two', 120, 40]]);
  sender.enqueue('two', 130, 45);
  sender.dispose();
  advance(100);
  await tick();
  assert.equal(calls.length, 2);
});

test('clearing a resize before its send starts prevents a stale request', async () => {
  const calls = [];
  const { sender } = fixture(async (...args) => { calls.push(args); });
  sender.enqueue('old', 80, 24);
  sender.clear();
  await tick();
  assert.deepEqual(calls, []);
});

test('release flush sends the latest pending size without waiting for the pacing timer', async () => {
  const calls = [];
  const { sender, advance } = fixture(async (...args) => { calls.push(args); });
  sender.enqueue('one', 80, 24);
  await tick();
  advance(10);
  sender.enqueue('one', 100, 30);
  sender.flush();
  await tick();
  assert.deepEqual(calls, [['one', 80, 24], ['one', 100, 30]]);
  advance(100);
  await tick();
  assert.equal(calls.length, 2);
});

test('release flush waits for an in-flight resize, then sends the newest size immediately', async () => {
  const calls = [];
  const releases = [];
  const { sender } = fixture((...args) => { calls.push(args); return new Promise((resolve) => releases.push(resolve)); });
  sender.enqueue('one', 80, 24);
  await tick();
  sender.enqueue('one', 90, 25);
  sender.flush();
  sender.enqueue('one', 100, 30);
  assert.deepEqual(calls, [['one', 80, 24]]);
  releases.shift()();
  await tick();
  assert.deepEqual(calls, [['one', 80, 24], ['one', 100, 30]]);
  releases.shift()();
  await tick();
});
