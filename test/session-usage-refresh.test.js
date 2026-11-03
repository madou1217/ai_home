'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createSessionUsageRefresh } = require('../lib/usage/session-usage-refresh');

function createHarness({ scan, warns = [] }) {
  return createSessionUsageRefresh({
    label: 'CodeBuddy',
    enabled: true,
    modelUsageService: {},
    scan,
    resolveSession: () => ({ provider: 'codebuddy', sessionId: 'session-1' }),
    logWarn: (message) => warns.push(message),
    setTimeoutFn: (fn) => setTimeout(fn, 0),
    clearTimeoutFn: (timer) => clearTimeout(timer)
  });
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

// worker 正忙时扫描队列会满 —— 那是背压，不是失败。这一轮按退避重试就行，
// 不能每次重试都往日志里甩一条「refresh failed」（实测一分钟几十条）。
test('队列满不按失败刷日志，但仍然重试', async () => {
  const warns = [];
  let calls = 0;
  const refresh = createHarness({
    warns,
    scan: async () => {
      calls += 1;
      const error = new Error('model_usage_scan_queue_full');
      error.code = 'model_usage_scan_queue_full';
      throw error;
    }
  });
  refresh.start();
  refresh.notify({ provider: 'codebuddy', type: 'session:file-changed' });
  await flush();
  refresh.stop();

  assert.ok(calls > 1, '背压之后要按退避重试，而不是放弃');
  assert.deepEqual(warns, []);
});

test('真正的失败仍然要报警', async () => {
  const warns = [];
  const refresh = createHarness({
    warns,
    scan: async () => {
      const error = new Error('scan_disk_broken');
      error.code = 'scan_disk_broken';
      throw error;
    }
  });
  refresh.start();
  refresh.notify({ provider: 'codebuddy', type: 'session:file-changed' });
  await flush();
  refresh.stop();

  assert.equal(warns.length > 0, true);
  assert.match(warns[0], /scan_disk_broken/);
});
