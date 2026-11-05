'use strict';

// 换号后的自动「继续」：等 TUI 就绪再写，文字与回车分两次。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CONTINUE_PROMPT,
  scheduleContinuePrompt
} = require('../lib/cli/services/pty/switch-continue');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('就绪后才写：先文字、再单独一个回车', async () => {
  const writes = [];
  let ready = false;
  const handle = scheduleContinuePrompt({
    isCurrent: () => true,
    isReady: () => ready,
    write: (value) => writes.push(value),
    pollIntervalMs: 1,
    readyDelayMs: 1,
    enterDelayMs: 1
  });
  await sleep(20);
  assert.deepEqual(writes, [], '首帧之前一个字节都不写');

  ready = true;
  await sleep(40);
  assert.deepEqual(writes, [CONTINUE_PROMPT, '\r']);
  assert.equal(CONTINUE_PROMPT, 'continue');
  handle.cancel();
});

test('超时放弃：TUI 一直没起来就不写', async () => {
  const writes = [];
  scheduleContinuePrompt({
    isCurrent: () => true,
    isReady: () => false,
    write: (value) => writes.push(value),
    pollIntervalMs: 1,
    timeoutMs: 10
  });
  await sleep(60);
  assert.deepEqual(writes, []);
});

test('换号已切走：isCurrent=false 后不再写', async () => {
  const writes = [];
  let current = true;
  let ready = false;
  const handle = scheduleContinuePrompt({
    isCurrent: () => current,
    isReady: () => ready,
    write: (value) => writes.push(value),
    pollIntervalMs: 1,
    readyDelayMs: 1,
    enterDelayMs: 1
  });
  ready = true;
  current = false;
  await sleep(40);
  assert.deepEqual(writes, []);
  handle.cancel();
});

test('cancel 之后连回车也不写', async () => {
  const writes = [];
  const handle = scheduleContinuePrompt({
    isCurrent: () => true,
    isReady: () => true,
    write: (value) => writes.push(value),
    pollIntervalMs: 1,
    readyDelayMs: 5,
    enterDelayMs: 5
  });
  handle.cancel();
  await sleep(40);
  assert.deepEqual(writes, []);
});
