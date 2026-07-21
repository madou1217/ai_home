'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createHookSelfHealLoop } = require('../lib/server/hook-self-heal');

function createTimerFixture() {
  let callback = null;
  let cleared = false;
  return {
    setInterval(next) {
      callback = next;
      return { unref() {} };
    },
    clearInterval() {
      cleared = true;
    },
    run() {
      return callback();
    },
    wasCleared() {
      return cleared;
    }
  };
}

test('hook self-heal suspends terminal install failures', () => {
  const timer = createTimerFixture();
  const failures = [];
  let attempts = 0;
  const loop = createHookSelfHealLoop({
    intervalMs: 1_000,
    setInterval: timer.setInterval,
    clearInterval: timer.clearInterval,
    ensureInstalled() {
      attempts += 1;
      return {
        ok: false,
        retryable: false,
        reason: 'hook_target_not_writable',
        errorCode: 'EPERM'
      };
    },
    onFailure: (failure) => failures.push(failure)
  });

  timer.run();
  timer.run();

  assert.equal(attempts, 1);
  assert.equal(loop.getState().suspended, true);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].suspended, true);
});

test('hook self-heal exponentially backs off transient failures and resets after success', () => {
  const timer = createTimerFixture();
  const failures = [];
  let currentTime = 0;
  let attempts = 0;
  let shouldFail = true;
  const loop = createHookSelfHealLoop({
    intervalMs: 1_000,
    maxBackoffMs: 8_000,
    now: () => currentTime,
    setInterval: timer.setInterval,
    clearInterval: timer.clearInterval,
    ensureInstalled() {
      attempts += 1;
      if (shouldFail) throw new Error('transient');
      return { ok: true, repaired: false };
    },
    onFailure: (failure) => failures.push(failure)
  });

  timer.run();
  assert.equal(attempts, 1);
  assert.equal(loop.getState().nextAttemptAt, 1_000);

  currentTime = 999;
  timer.run();
  assert.equal(attempts, 1);

  currentTime = 1_000;
  timer.run();
  assert.equal(attempts, 2);
  assert.equal(loop.getState().nextAttemptAt, 3_000);

  currentTime = 3_000;
  shouldFail = false;
  timer.run();
  assert.equal(attempts, 3);
  assert.equal(loop.getState().consecutiveFailures, 0);
  assert.equal(loop.getState().nextAttemptAt, 0);
  assert.deepEqual(failures.map((failure) => failure.consecutiveFailures), [1, 2]);
});

test('hook self-heal stop is idempotent and prevents later work', () => {
  const timer = createTimerFixture();
  let attempts = 0;
  const loop = createHookSelfHealLoop({
    setInterval: timer.setInterval,
    clearInterval: timer.clearInterval,
    ensureInstalled() {
      attempts += 1;
      return { ok: true };
    }
  });

  loop.stop();
  loop.stop();
  timer.run();

  assert.equal(timer.wasCleared(), true);
  assert.equal(attempts, 0);
});
