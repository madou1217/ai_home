'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const {
  createModelUsageScanExecutor,
  DEFAULT_SCAN_QUEUE_LIMIT,
  DEFAULT_SCAN_TIMEOUT_MS
} = require('../lib/usage/model-usage-scan-executor');

// 扫描进 worker 是为了别卡主线程（GB 级会话 JSONL 的同步读）。执行器的接口很窄：
// 排队、合并、超时、worker 死亡后的重建 —— 这些都不该靠真 worker 才能验证。
class FakeWorker extends EventEmitter {
  constructor(workerPath, options) {
    super();
    this.workerPath = workerPath;
    this.options = options;
    this.messages = [];
    this.refs = 0;
    this.unrefs = 0;
    this.terminated = false;
    FakeWorker.instances.push(this);
  }

  ref() { this.refs += 1; }

  unref() { this.unrefs += 1; }

  postMessage(message) { this.messages.push(message); }

  terminate() {
    this.terminated = true;
    return Promise.resolve(0);
  }

  reply(message) { this.emit('message', message); }
}
FakeWorker.instances = [];

function resetWorkers() {
  FakeWorker.instances = [];
}

function createExecutor(overrides = {}) {
  return createModelUsageScanExecutor({
    Worker: FakeWorker,
    workerPath: '/tmp/fake-scan-worker.js',
    ...overrides
  });
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('扫描交给 worker：postMessage 带 id/method/scan，结果原样返回', async () => {
  resetWorkers();
  const executor = createExecutor();
  const pending = executor.execute({ provider: 'codex' });
  await tick();

  assert.equal(FakeWorker.instances.length, 1);
  const worker = FakeWorker.instances[0];
  assert.equal(worker.messages.length, 1);
  assert.equal(worker.messages[0].method, 'scan');
  assert.deepEqual(worker.messages[0].scan, { provider: 'codex' });
  assert.equal(worker.refs, 1, '跑任务时 worker 必须 ref，否则进程可能在扫描中途退出');

  const result = { files: 2, records: 3, providers: { codex: { files: 2 } } };
  worker.reply({ id: worker.messages[0].id, ok: true, result });
  assert.deepEqual(await pending, result);
  assert.ok(worker.unrefs >= 1, '空闲 worker 必须 unref，否则 server 退不掉');
  await executor.close();
});

test('同一份扫描请求合并：刷新风暴不会把队列打满', async () => {
  resetWorkers();
  const executor = createExecutor({ queueLimit: 1 });
  const first = executor.execute({ provider: 'codebuddy' });
  const second = executor.execute({ provider: 'codebuddy' });
  await tick();

  const worker = FakeWorker.instances[0];
  assert.equal(worker.messages.length, 1, '同一个 provider 的重复刷新只能占一个 worker 任务');

  const result = { files: 1, records: 0 };
  worker.reply({ id: worker.messages[0].id, ok: true, result });
  assert.deepEqual(await first, result);
  assert.deepEqual(await second, result);

  // 合并窗口随任务结束关闭：下一次刷新要真的再扫一遍。
  const third = executor.execute({ provider: 'codebuddy' });
  await tick();
  assert.equal(worker.messages.length, 2);
  worker.reply({ id: worker.messages[1].id, ok: true, result });
  await third;
  await executor.close();
});

test('不同请求仍按队列上限拒绝，不静默丢弃', async () => {
  resetWorkers();
  const executor = createExecutor({ queueLimit: 2 });
  const running = executor.execute({ provider: 'codex' });
  const queuedA = executor.execute({ provider: 'claude' });
  const queuedB = executor.execute({ provider: 'gemini' });
  await tick();

  await assert.rejects(
    executor.execute({ provider: 'kimi' }),
    (error) => error.code === 'model_usage_scan_queue_full'
  );

  const worker = FakeWorker.instances[0];
  const result = { files: 0 };
  worker.reply({ id: worker.messages[0].id, ok: true, result });
  await running;
  await tick();
  worker.reply({ id: worker.messages[1].id, ok: true, result });
  await queuedA;
  await tick();
  worker.reply({ id: worker.messages[2].id, ok: true, result });
  await queuedB;
  await executor.close();
});

test('worker 报错：拒绝值保留错误码', async () => {
  resetWorkers();
  const executor = createExecutor();
  const pending = executor.execute({ provider: 'codex' });
  await tick();

  const worker = FakeWorker.instances[0];
  worker.reply({
    id: worker.messages[0].id,
    ok: false,
    error: { name: 'Error', code: 'scan_boom', message: 'scan_boom:disk' }
  });
  await assert.rejects(pending, (error) => error.code === 'scan_boom' && /disk/.test(error.message));
  await executor.close();
});

test('超时：任务被判死并终止 worker', async () => {
  resetWorkers();
  // 超时定时器是 unref 的（生产中靠 ref 住的 worker 撑着事件循环），测试里要自己撑住。
  const keepAlive = setInterval(() => {}, 5);
  try {
    const executor = createExecutor({ timeoutMs: 30 });
    const pending = executor.execute({ provider: 'codex' });
    await tick();

    await assert.rejects(pending, (error) => error.code === 'model_usage_scan_timeout');
    const worker = FakeWorker.instances[0];
    assert.equal(worker.terminated, true, '超时后必须 terminate，不能留一个还在读 GB 级文件的线程');
    await executor.close();
  } finally {
    clearInterval(keepAlive);
  }
});

test('worker 意外退出：在跑的任务被拒绝', async () => {
  resetWorkers();
  const executor = createExecutor();
  const pending = executor.execute({ provider: 'codex' });
  await tick();

  FakeWorker.instances[0].emit('exit', 1);
  await assert.rejects(pending, (error) => error.code === 'model_usage_scan_worker_exited');
  await executor.close();
});

test('close()：排队与在跑的任务一起拒绝，之后不再接新任务', async () => {
  resetWorkers();
  const executor = createExecutor({ queueLimit: 4 });
  const running = executor.execute({ provider: 'codex' });
  const queued = executor.execute({ provider: 'claude' });
  await tick();

  const closing = executor.close();
  await assert.rejects(running, (error) => error.code === 'model_usage_scan_executor_closed');
  await assert.rejects(queued, (error) => error.code === 'model_usage_scan_executor_closed');
  await closing;
  await assert.rejects(
    executor.execute({ provider: 'gemini' }),
    (error) => error.code === 'model_usage_scan_executor_closed'
  );
  assert.equal(executor.getState().closed, true);
});

test('默认参数与状态快照', async () => {
  resetWorkers();
  const executor = createExecutor();
  const state = executor.getState();
  assert.equal(state.timeoutMs, DEFAULT_SCAN_TIMEOUT_MS);
  assert.equal(state.queueLimit, DEFAULT_SCAN_QUEUE_LIMIT);
  assert.equal(state.running, false);
  assert.equal(state.workerAlive, false);
  await executor.close();
});
