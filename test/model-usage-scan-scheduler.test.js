'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createModelUsageScanScheduler } = require('../lib/usage/model-usage-scheduler');

// 定时扫描必须走 scanAsync（worker 线程）：走同步 scan 就是把 GB 级会话 JSONL
// 的同步读重新搬回主事件循环，网关请求和健康探针会一起被卡住。
test('定时扫描优先走 scanAsync（worker），不走同步 scan', async () => {
  const calls = [];
  const service = {
    scanAsync: async (scanOptions) => { calls.push(['async', scanOptions]); return { files: 1, records: 2 }; },
    scan: () => { calls.push(['sync']); return { files: 9 }; }
  };
  const scheduler = createModelUsageScanScheduler({ modelUsageService: service, config: { enabled: true } });

  const result = await scheduler.runScanNow('test');
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [['async', { reindexCodexForkHistory: false }]]);
});

test('没有 scanAsync 的旧实现仍按 Promise 化的同步扫描跑', async () => {
  const calls = [];
  const service = { scan: () => { calls.push('sync'); return { files: 3, records: 0 }; } };
  const scheduler = createModelUsageScanScheduler({ modelUsageService: service, config: { enabled: true } });

  const result = await scheduler.runScanNow('test');
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ['sync']);
});

test('扫描进行中再触发：直接跳过，不叠第二份扫描', async () => {
  let release = null;
  let calls = 0;
  const service = {
    scanAsync: () => { calls += 1; return new Promise((resolve) => { release = () => resolve({ files: 1 }); }); },
    scan: () => { throw new Error('同步扫描不该被调用'); }
  };
  const scheduler = createModelUsageScanScheduler({ modelUsageService: service, config: { enabled: true } });

  const first = scheduler.runScanNow('test');
  await new Promise((resolve) => setImmediate(resolve));
  const second = await scheduler.runScanNow('test');
  assert.deepEqual(second, { ok: false, skipped: true, reason: 'already_running' });
  release();
  await first;
  assert.equal(calls, 1);
});

test('scanAsync 失败时把错误带回去，不吞掉', async () => {
  const service = {
    scanAsync: async () => {
      const error = new Error('model_usage_scan_queue_full');
      error.code = 'model_usage_scan_queue_full';
      throw error;
    },
    scan: () => { throw new Error('同步扫描不该被调用'); }
  };
  const scheduler = createModelUsageScanScheduler({ modelUsageService: service, config: { enabled: true } });
  const result = await scheduler.runScanNow('test');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'model_usage_scan_queue_full');
});
