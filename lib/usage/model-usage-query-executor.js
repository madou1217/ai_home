'use strict';

const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');

const QUERY_METHODS = new Set([
  'getDashboard',
  'getStats',
  'getCostByModel',
  'getSessions',
  'getSessionDetail'
]);
const DEFAULT_QUERY_CONCURRENCY = Math.max(
  1,
  Math.min(4, Math.max(1, os.availableParallelism() - 1))
);
const DEFAULT_QUERY_QUEUE_LIMIT = 32;
const DEFAULT_QUERY_TIMEOUT_MS = 25_000;

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
  const error = new Error(String(payload.message || 'model_usage_query_failed'));
  error.name = String(payload.name || 'Error');
  error.code = String(payload.code || 'model_usage_query_failed');
  if (payload.stack) error.stack = String(payload.stack);
  return error;
}

function createModelUsageQueryExecutor(options = {}) {
  const WorkerCtor = options.Worker || Worker;
  const workerPath = String(
    options.workerPath || path.join(__dirname, 'model-usage-query-worker.js')
  );
  const concurrency = positiveInteger(options.concurrency, DEFAULT_QUERY_CONCURRENCY);
  const queueLimit = positiveInteger(options.queueLimit, DEFAULT_QUERY_QUEUE_LIMIT);
  const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_QUERY_TIMEOUT_MS);
  const workerData = {
    serviceOptions: options.serviceOptions || {}
  };
  const workers = new Set();
  const queue = [];
  let nextJobId = 1;
  let closed = false;

  function clearJobTimer(job) {
    if (!job || !job.timer) return;
    clearTimeout(job.timer);
    job.timer = null;
  }

  function retireWorker(slot, error) {
    if (!slot || slot.retired) return;
    slot.retired = true;
    workers.delete(slot);
    if (slot.job) {
      const job = slot.job;
      slot.job = null;
      clearJobTimer(job);
      job.reject(error || createExecutorError('model_usage_query_worker_exited'));
    }
    if (!closed) dispatch();
  }

  function handleWorkerMessage(slot, message = {}) {
    const job = slot && slot.job;
    if (!job || Number(message.id) !== job.id) return;
    slot.job = null;
    clearJobTimer(job);
    if (message.ok === true) {
      job.resolve(message.result);
    } else {
      job.reject(deserializeWorkerError(message.error));
    }
    dispatch();
    if (!slot.job && typeof slot.worker.unref === 'function') slot.worker.unref();
  }

  function createWorkerSlot() {
    const worker = new WorkerCtor(workerPath, { workerData });
    const slot = { worker, job: null, retired: false };
    workers.add(slot);
    worker.on('message', (message) => handleWorkerMessage(slot, message));
    worker.on('error', (error) => {
      retireWorker(slot, error);
    });
    worker.on('exit', (code) => {
      if (slot.retired) return;
      retireWorker(slot, createExecutorError(
        'model_usage_query_worker_exited',
        `model_usage_query_worker_exited:${Number(code) || 0}`
      ));
    });
    if (typeof worker.unref === 'function') worker.unref();
    return slot;
  }

  function startJob(slot, job) {
    slot.job = job;
    if (typeof slot.worker.ref === 'function') slot.worker.ref();
    job.timer = setTimeout(() => {
      const error = createExecutorError(
        'model_usage_query_timeout',
        `model_usage_query_timeout:${timeoutMs}`
      );
      retireWorker(slot, error);
      Promise.resolve(slot.worker.terminate()).catch(() => {});
    }, timeoutMs);
    if (job.timer && typeof job.timer.unref === 'function') job.timer.unref();
    try {
      slot.worker.postMessage({
        id: job.id,
        method: job.method,
        query: job.query
      });
    } catch (error) {
      retireWorker(slot, error);
      Promise.resolve(slot.worker.terminate()).catch(() => {});
    }
  }

  function dispatch() {
    if (closed) return;
    while (queue.length > 0) {
      let slot = Array.from(workers).find((candidate) => !candidate.job && !candidate.retired);
      if (!slot && workers.size < concurrency) slot = createWorkerSlot();
      if (!slot) return;
      startJob(slot, queue.shift());
    }
  }

  function execute(method, query = {}) {
    const normalizedMethod = String(method || '').trim();
    if (!QUERY_METHODS.has(normalizedMethod)) {
      return Promise.reject(createExecutorError('model_usage_query_method_invalid'));
    }
    if (closed) {
      return Promise.reject(createExecutorError('model_usage_query_executor_closed'));
    }
    if (queue.length >= queueLimit) {
      return Promise.reject(createExecutorError('model_usage_query_queue_full'));
    }
    return new Promise((resolve, reject) => {
      queue.push({
        id: nextJobId,
        method: normalizedMethod,
        query,
        resolve,
        reject,
        timer: null
      });
      nextJobId += 1;
      dispatch();
    });
  }

  async function close() {
    if (closed) return;
    closed = true;
    const error = createExecutorError('model_usage_query_executor_closed');
    queue.splice(0).forEach((job) => job.reject(error));
    const terminations = Array.from(workers).map((slot) => {
      retireWorker(slot, error);
      return Promise.resolve(slot.worker.terminate()).catch(() => {});
    });
    await Promise.all(terminations);
  }

  function getState() {
    return {
      concurrency,
      queueLimit,
      timeoutMs,
      workers: workers.size,
      active: Array.from(workers).filter((slot) => Boolean(slot.job)).length,
      queued: queue.length,
      closed
    };
  }

  return Object.freeze({ execute, close, getState });
}

module.exports = {
  DEFAULT_QUERY_CONCURRENCY,
  DEFAULT_QUERY_QUEUE_LIMIT,
  DEFAULT_QUERY_TIMEOUT_MS,
  createModelUsageQueryExecutor
};
