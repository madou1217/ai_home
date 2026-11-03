'use strict';

const path = require('node:path');
const { Worker } = require('node:worker_threads');

// 扫描执行器：把「读 GB 级会话 JSONL + 落库」整体挪到 worker 线程。
//
// 为什么不是分片异步读：每个文件的投影是原子的（rebuild 时要整体
// replaceFileProjection，codex fork 重放还带跨行的 usage 基线），在主线程里切成
// 小块只会把一次长阻塞换成一串中等阻塞，且要在每个 provider 扫描器里重做游标语义。
// 放到 worker 后主事件循环完全不被占用，扫描本身的逻辑一行都不用改。
const DEFAULT_SCAN_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_SCAN_QUEUE_LIMIT = 2;

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function createExecutorError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function deserializeWorkerError(payload = {}) {
  const error = new Error(String(payload.message || 'model_usage_scan_failed'));
  error.name = String(payload.name || 'Error');
  error.code = String(payload.code || 'model_usage_scan_failed');
  if (payload.stack) error.stack = String(payload.stack);
  return error;
}

// 请求指纹：只对同一份 scan 参数去重。不可序列化的参数不合并（退回逐个排队）。
function scanRequestKey(scanOptions) {
  const source = scanOptions && typeof scanOptions === 'object' ? scanOptions : {};
  try {
    return JSON.stringify(Object.keys(source).sort().map((key) => [key, source[key]]));
  } catch (_error) {
    return '';
  }
}

function createModelUsageScanExecutor(options = {}) {
  const WorkerCtor = options.Worker || Worker;
  const workerPath = String(
    options.workerPath || path.join(__dirname, 'model-usage-scan-worker.js')
  );
  const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_SCAN_TIMEOUT_MS);
  const queueLimit = positiveInteger(options.queueLimit, DEFAULT_SCAN_QUEUE_LIMIT);
  const workerData = {
    serviceOptions: options.serviceOptions || {}
  };

  // 扫描是写操作：同一时刻只跑一个，跑第二个只会抢 SQLite 写锁。
  let slot = null;
  const pendingByKey = new Map(); // 请求指纹 → 正在排队/执行的同一个 promise
  const queue = [];
  let nextJobId = 1;
  let closed = false;

  function clearJobTimer(job) {
    if (!job || !job.timer) return;
    clearTimeout(job.timer);
    job.timer = null;
  }

  function retireWorker(error) {
    if (!slot) return;
    const retired = slot;
    slot = null;
    if (retired.job) {
      const job = retired.job;
      retired.job = null;
      clearJobTimer(job);
      job.reject(error || createExecutorError('model_usage_scan_worker_exited'));
    }
    dispatch();
  }

  function handleWorkerMessage(workerSlot, message = {}) {
    const job = workerSlot && workerSlot.job;
    if (!job || Number(message.id) !== job.id) return;
    workerSlot.job = null;
    clearJobTimer(job);
    if (message.ok === true) {
      job.resolve(message.result);
    } else {
      job.reject(deserializeWorkerError(message.error));
    }
    if (typeof workerSlot.worker.unref === 'function') workerSlot.worker.unref();
    dispatch();
  }

  function createWorkerSlot() {
    const worker = new WorkerCtor(workerPath, { workerData });
    const workerSlot = { worker, job: null };
    worker.on('message', (message) => handleWorkerMessage(workerSlot, message));
    worker.on('error', (error) => {
      if (slot !== workerSlot) return;
      retireWorker(error);
    });
    worker.on('exit', (code) => {
      if (slot !== workerSlot) return;
      retireWorker(createExecutorError(
        'model_usage_scan_worker_exited',
        `model_usage_scan_worker_exited:${Number(code) || 0}`
      ));
    });
    // 空闲的 worker 不该把父进程钉住（server 靠 unref 才能正常退出）。
    if (typeof worker.unref === 'function') worker.unref();
    return workerSlot;
  }

  function startJob(workerSlot, job) {
    workerSlot.job = job;
    if (typeof workerSlot.worker.ref === 'function') workerSlot.worker.ref();
    job.timer = setTimeout(() => {
      const error = createExecutorError(
        'model_usage_scan_timeout',
        `model_usage_scan_timeout:${timeoutMs}`
      );
      retireWorker(error);
      Promise.resolve(workerSlot.worker.terminate()).catch(() => {});
    }, timeoutMs);
    if (job.timer && typeof job.timer.unref === 'function') job.timer.unref();
    try {
      workerSlot.worker.postMessage({
        id: job.id,
        method: 'scan',
        scan: job.scan
      });
    } catch (error) {
      retireWorker(error);
      Promise.resolve(workerSlot.worker.terminate()).catch(() => {});
    }
  }

  function dispatch() {
    if (closed || queue.length === 0) return;
    if (slot && slot.job) return;
    if (!slot) slot = createWorkerSlot();
    startJob(slot, queue.shift());
  }

  function execute(scanOptions = {}) {
    if (closed) return Promise.reject(createExecutorError('model_usage_scan_executor_closed'));
    // 同一份请求（同 provider 的刷新风暴）合并成一个任务：worker 忙着追赶历史时，
    // 每次文件变更都来一发扫描，去重前会把队列打满、把刷新打成 queue_full 报错。
    const key = scanRequestKey(scanOptions);
    const inflight = key ? pendingByKey.get(key) : null;
    if (inflight) return inflight;
    if (queue.length >= queueLimit) {
      return Promise.reject(createExecutorError('model_usage_scan_queue_full'));
    }
    const promise = new Promise((resolve, reject) => {
      queue.push({
        id: nextJobId,
        scan: scanOptions,
        resolve,
        reject,
        timer: null
      });
      nextJobId += 1;
      dispatch();
    });
    if (key) {
      pendingByKey.set(key, promise);
      // 结算后关掉合并窗口：下一次刷新必须真的再扫一遍。派生 promise 的两个分支
      // 都消费掉，避免未处理的 rejection。
      promise.then(() => pendingByKey.delete(key), () => pendingByKey.delete(key));
    }
    return promise;
  }

  async function close() {
    if (closed) return;
    closed = true;
    const error = createExecutorError('model_usage_scan_executor_closed');
    queue.splice(0).forEach((job) => job.reject(error));
    const workerSlot = slot;
    slot = null;
    if (!workerSlot) return;
    if (workerSlot.job) {
      clearJobTimer(workerSlot.job);
      workerSlot.job.reject(error);
      workerSlot.job = null;
    }
    await Promise.resolve(workerSlot.worker.terminate()).catch(() => {});
  }

  function getState() {
    return {
      timeoutMs,
      queueLimit,
      queued: queue.length,
      running: Boolean(slot && slot.job),
      workerAlive: Boolean(slot),
      closed
    };
  }

  return Object.freeze({ execute, close, getState });
}

module.exports = {
  DEFAULT_SCAN_TIMEOUT_MS,
  DEFAULT_SCAN_QUEUE_LIMIT,
  createModelUsageScanExecutor
};
