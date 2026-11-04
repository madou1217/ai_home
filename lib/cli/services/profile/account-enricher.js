'use strict';

const path = require('node:path');

// 列表补算的**主线程侧**：把逐个账号的重活丢给 worker，主线程永远只做渲染。
//
// 为什么必须异步到 worker：单个账号的补算（读凭据 + 刷新索引 + 用量标签 + 套餐徽章）
// 实测 ~100-200ms，全部留在主线程的话，40 个账号就是十来秒的断续卡顿——列表有内容
// 但转圈会一顿一顿。会话列表（persistent-session-rows-worker）已经是这个套路。
//
// 失败一律 fail-soft：worker 起不来 / 超时 / 崩溃都只返回 null，调用方沿用索引态
// 或者退回主线程补算，列表本身绝不因此不可用。

const DEFAULT_TIMEOUT_MS = 15000;

function createAccountEnricher(options = {}) {
  const WorkerCtor = options.Worker || require('node:worker_threads').Worker;
  const workerPath = String(options.workerPath || path.join(__dirname, 'account-enrich-worker.js'));
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS);
  const workerData = {
    aiHomeDir: String(options.aiHomeDir || '').trim(),
    hostHomeDir: options.hostHomeDir
  };

  let worker = null;
  let broken = false;
  let closed = false;
  let nextId = 1;
  let inflight = null;   // { id, resolve, timer }

  function disposeWorker() {
    if (!worker) return;
    const target = worker;
    worker = null;
    try { target.removeAllListeners(); } catch (_error) {}
    try { target.terminate(); } catch (_error) {}
  }

  function settle(results) {
    if (!inflight) return;
    const current = inflight;
    inflight = null;
    if (current.timer) clearTimeout(current.timer);
    if (worker && typeof worker.unref === 'function') worker.unref();
    current.resolve(results);
  }

  function ensureWorker() {
    if (worker || broken || closed) return worker;
    if (!workerData.aiHomeDir) return null;
    try {
      worker = new WorkerCtor(workerPath, { workerData });
    } catch (_error) {
      broken = true;
      return null;
    }
    worker.on('message', (message) => {
      const payload = message && typeof message === 'object' ? message : {};
      if (!inflight || Number(payload.id) !== inflight.id) return;
      settle(payload.ok === true && Array.isArray(payload.results) ? payload.results : null);
    });
    const fail = () => {
      disposeWorker();
      settle(null);
    };
    worker.on('error', fail);
    worker.on('exit', (code) => {
      if (closed) return;
      if (code !== 0) broken = false;
      disposeWorker();
      settle(null);
    });
    if (typeof worker.unref === 'function') worker.unref();
    return worker;
  }

  /**
   * 补算一批账号。返回 results 数组；worker 不可用时返回 null（调用方兜底）。
   * @param {Array<{provider: string, accountRef: string, indexRow?: object}>} tasks
   */
  function request(tasks) {
    const list = Array.isArray(tasks) ? tasks.filter((task) => task && task.provider && task.accountRef) : [];
    if (list.length === 0) return Promise.resolve([]);
    if (closed) return Promise.resolve(null);
    const target = ensureWorker();
    if (!target) return Promise.resolve(null);
    if (inflight) return Promise.resolve(null);
    const id = nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        // 超时：worker 可能卡在上游/锁上，直接丢弃，交给下一次请求重新起。
        inflight = null;
        disposeWorker();
        resolve(null);
      }, timeoutMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
      inflight = { id, resolve, timer };
      // 有请求在飞时必须 ref：否则事件循环里没有引用，进程会先退出。
      if (typeof target.ref === 'function') target.ref();
      try {
        target.postMessage({ id, tasks: list });
      } catch (_error) {
        settle(null);
      }
    });
  }

  function close() {
    closed = true;
    settle(null);
    disposeWorker();
  }

  return {
    request,
    close,
    get available() {
      return !broken && !closed;
    }
  };
}

module.exports = {
  createAccountEnricher
};
