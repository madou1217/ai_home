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
// 队列只防内存失控，不是并发闸门（同一时刻永远只跑一个扫描）。2 会把启动期的
// 正常刷新风暴直接判成 queue_full；16 足够吸收一次突发，超出的仍按失败返回。
const DEFAULT_SCAN_QUEUE_LIMIT = 16;
// 「宽扫描」= 只声明 provider（或什么都不声明），不带会话 id / 时窗过滤。
// 这类请求可以并成一次全量扫描：全量结果是每个宽请求的超集。对应 Redis pipeline，
// 多条命令合成一次往返，而不是各排一个必死的队列位。
const BROAD_SCAN_KEYS = new Set(['provider', 'providers', 'reindexCodexForkHistory']);

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

function isBroadScan(scanOptions) {
  const source = scanOptions && typeof scanOptions === 'object' ? scanOptions : {};
  const keys = Object.keys(source);
  return keys.length === 0 || keys.every((key) => BROAD_SCAN_KEYS.has(key));
}

// 合并后的扫描不再带 provider 过滤：一次全量扫描覆盖所有排队中的宽请求。
function mergeBroadScan(left, right) {
  const reindex = (left && left.reindexCodexForkHistory === true)
    || (right && right.reindexCodexForkHistory === true);
  return reindex ? { reindexCodexForkHistory: true } : {};
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
  let coalesced = 0;

  function clearJobTimer(job) {
    if (!job || !job.timer) return;
    clearTimeout(job.timer);
    job.timer = null;
  }

  // 一个 job 可能挂多个等待方（宽请求合并后共用同一份全量结果）。
  function settleJob(job, error, result) {
    clearJobTimer(job);
    const waiters = job && Array.isArray(job.waiters) ? job.waiters.splice(0) : [];
    for (const waiter of waiters) {
      if (error) waiter.reject(error);
      else waiter.resolve(result);
    }
  }

  function retireWorker(error) {
    if (!slot) return;
    const retired = slot;
    slot = null;
    if (retired.job) {
      const job = retired.job;
      retired.job = null;
      settleJob(job, error || createExecutorError('model_usage_scan_worker_exited'));
    }
    dispatch();
  }

  function handleWorkerMessage(workerSlot, message = {}) {
    const job = workerSlot && workerSlot.job;
    if (!job || Number(message.id) !== job.id) return;
    workerSlot.job = null;
    if (message.ok === true) {
      settleJob(job, null, message.result);
    } else {
      settleJob(job, deserializeWorkerError(message.error));
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
    job.started = true;
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

  // 同一轮事件循环里的多个扫描请求先攒一下再派发（Redis pipeline 的批量语义）：
  // 否则第一个请求立刻占住 slot，后面同时到达的宽请求就没机会并进同一个 job。
  let dispatchScheduled = false;
  function scheduleDispatch() {
    if (dispatchScheduled) return;
    dispatchScheduled = true;
    setImmediate(() => {
      dispatchScheduled = false;
      dispatch();
    });
  }

  function execute(scanOptions = {}) {
    if (closed) return Promise.reject(createExecutorError('model_usage_scan_executor_closed'));
    // 同一份请求（同 provider 的刷新风暴）合并成一个任务：worker 忙着追赶历史时，
    // 每次文件变更都来一发扫描，去重前会把队列打满、把刷新打成 queue_full 报错。
    const key = scanRequestKey(scanOptions);
    const inflight = key ? pendingByKey.get(key) : null;
    if (inflight) return inflight;

    const broad = isBroadScan(scanOptions);
    let job = broad ? queue.find((item) => item.broad && !item.started) : null;
    if (job) {
      // 排队中的宽请求并成一次全量扫描（Redis pipeline）：不新增队列位，
      // 所有等待方共享同一份全量结果。
      job.scan = mergeBroadScan(job.scan, scanOptions);
      coalesced += 1;
    } else {
      if (queue.length >= queueLimit) {
        return Promise.reject(createExecutorError('model_usage_scan_queue_full'));
      }
      job = {
        id: nextJobId,
        scan: scanOptions,
        broad,
        started: false,
        waiters: [],
        timer: null
      };
      nextJobId += 1;
      queue.push(job);
    }

    const promise = new Promise((resolve, reject) => {
      job.waiters.push({ resolve, reject });
    });
    if (key) {
      pendingByKey.set(key, promise);
      // 结算后关掉合并窗口：下一次刷新必须真的再扫一遍。派生 promise 的两个分支
      // 都消费掉，避免未处理的 rejection。
      promise.then(() => pendingByKey.delete(key), () => pendingByKey.delete(key));
    }
    scheduleDispatch();
    return promise;
  }

  async function close() {
    if (closed) return;
    closed = true;
    const error = createExecutorError('model_usage_scan_executor_closed');
    queue.splice(0).forEach((job) => settleJob(job, error));
    const workerSlot = slot;
    slot = null;
    if (!workerSlot) return;
    if (workerSlot.job) {
      settleJob(workerSlot.job, error);
      workerSlot.job = null;
    }
    await Promise.resolve(workerSlot.worker.terminate()).catch(() => {});
  }

  function getState() {
    return {
      timeoutMs,
      queueLimit,
      queued: queue.length,
      coalesced,
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
