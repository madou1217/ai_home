'use strict';

const path = require('node:path');

// 持久会话列表的**异步采集器**：把 collectGlobalPersistentSessionRows 放到 worker 里跑。
//
// 为什么需要：选择器每 1.5s 刷新一次会话状态，采集要 spawn 每个账号 socket 的 tmux 再读
// 会话库（实测 90~260ms）。这些调用留在主线程时，按 x / q / Esc 会等它跑完才被处理，
// 用起来就是「卡」。放到 worker 后主线程只做渲染，按键响应回到毫秒级。
//
// 失败一律 fail-soft：worker 起不来 / 超时 / 抛错都只代表「这次没刷到新数据」，调用方
// 沿用上一次的列表，绝不让列表本身不可用。

const DEFAULT_TIMEOUT_MS = 20000;

function createSessionRowsRefresher(options = {}) {
  const WorkerCtor = options.Worker || require('node:worker_threads').Worker;
  const workerPath = String(options.workerPath || path.join(__dirname, 'persistent-session-rows-worker.js'));
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS);
  const requestPayload = {
    aiHomeDir: String(options.aiHomeDir || '').trim(),
    hostHomeDir: options.hostHomeDir,
    providers: Array.isArray(options.providers) ? options.providers : undefined,
    skipAgentTitles: options.skipAgentTitles === true
  };

  let worker = null;
  let workerBroken = false;
  let nextId = 1;
  let inflight = null;   // { id, promise, resolve, timer }
  let closed = false;

  function disposeWorker() {
    if (!worker) return;
    const target = worker;
    worker = null;
    try { target.removeAllListeners(); } catch (_error) {}
    try { target.terminate(); } catch (_error) {}
  }

  function settle(rows) {
    if (!inflight) return;
    const current = inflight;
    inflight = null;
    if (current.timer) clearTimeout(current.timer);
    if (worker && typeof worker.unref === 'function') worker.unref();
    current.resolve(rows);
  }

  function ensureWorker() {
    if (worker || workerBroken || closed) return worker;
    try {
      worker = new WorkerCtor(workerPath);
    } catch (_error) {
      workerBroken = true;
      return null;
    }
    worker.on('message', (message) => {
      const payload = message && typeof message === 'object' ? message : {};
      if (!inflight || Number(payload.id) !== inflight.id) return;
      settle(payload.ok === true && Array.isArray(payload.rows) ? payload.rows : null);
    });
    // worker 自己崩了：本次返回「没有新数据」，下次重新起一个，永不把主线程拖下水。
    const fail = () => {
      disposeWorker();
      settle(null);
    };
    worker.on('error', fail);
    worker.on('exit', (code) => {
      if (closed) return;
      if (code !== 0) workerBroken = false;
      disposeWorker();
      settle(null);
    });
    // 空闲时 unref：选择器退出后残留的 worker 不该拖住进程。
    // 请求期间再 ref（见 request）：否则「只有请求在飞」时事件循环里没有引用，
    // 进程会先退出、结果永远等不到（worker 的 promise 本身不持有事件循环）。
    if (typeof worker.unref === 'function') worker.unref();
    return worker;
  }

  return {
    /** 发起一次刷新；并发调用共用同一个请求，返回 rows 或 null（失败/无更新）。 */
    request() {
      if (closed) return Promise.resolve(null);
      if (inflight) return inflight.promise;
      const target = ensureWorker();
      if (!target) return Promise.resolve(null);
      const id = nextId++;
      if (typeof target.ref === 'function') target.ref();
      const promise = new Promise((resolve) => {
        inflight = { id, resolve, promise: null, timer: null };
        inflight.timer = setTimeout(() => {
          // 超时：丢掉这个 worker（可能卡在某个 spawn 上），下一次重新起。
          disposeWorker();
          settle(null);
        }, timeoutMs);
        if (typeof inflight.timer.unref === 'function') inflight.timer.unref();
      });
      inflight.promise = promise;
      try {
        target.postMessage({ ...requestPayload, id });
      } catch (_error) {
        disposeWorker();
        settle(null);
      }
      return promise;
    },
    close() {
      if (closed) return;
      closed = true;
      if (inflight) settle(null);
      disposeWorker();
    }
  };
}

module.exports = { createSessionRowsRefresher };
