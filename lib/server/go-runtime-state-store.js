'use strict';

// 账号运行态的进程内真相 + Go 持久化通道。
//
// 为什么不直接把 select 打到 aih.db：
//   * 选号器每个候选账号都要读一次运行态（热路径），本进程刚写的状态必须立即可见；
//   * Node 用 HTTP 异步推给 Go，提交到 SQLite 有几十毫秒窗口，直接读库会读到旧值。
// 因此：
//   * 内存 Map 是本进程的权威值（写后立即可读）；
//   * 每次写入异步推给 Go（Go 是跨进程/跨重启的存储真相）；
//   * 推送失败的条目保持 dirty，由 flush()（对账轮）重试；
//   * hydrate() 在启动时用 Go 的文档回填内存。

const DEFAULT_RETRY_MS = 60_000;

function normalizeAccountRef(value) {
  const ref = String(value || '').trim();
  return /^acct_[a-f0-9]{20}$/.test(ref) ? ref : '';
}

function normalizeState(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

/**
 * @param {object} options
 * @param {{get: Function, list: Function}} options.reader Go 文档只读快照（hydrate 用）
 * @param {(ref: string, state: object|null, updatedAt: number) => Promise<any>} options.put Go 写入
 * @param {(ref: string, updatedAt: number) => Promise<any>} options.remove Go 删除
 */
function createGoRuntimeStateStore(options = {}) {
  const reader = options.reader || null;
  const put = typeof options.put === 'function' ? options.put : null;
  const remove = typeof options.remove === 'function' ? options.remove : null;
  // retryMs=0 表示立即可重试（测试与显式 flush 场景）；缺省 60s。
  const retryMs = Number.isFinite(Number(options.retryMs)) && Number(options.retryMs) >= 0
    ? Number(options.retryMs)
    : DEFAULT_RETRY_MS;

  /** @type {Map<string, {state: object|null, updatedAt: number}>} */
  const entries = new Map();
  /** @type {Map<string, number>} 推送失败的账号 → 下次允许重试的时间 */
  const dirty = new Map();
  let flushPromise = null;
  let flushQueued = false;

  function get(accountRef) {
    const ref = normalizeAccountRef(accountRef);
    if (!ref) return null;
    const entry = entries.get(ref);
    return entry || null;
  }

  function list() {
    return Array.from(entries, ([accountRef, entry]) => ({
      accountRef,
      state: entry.state,
      updatedAt: entry.updatedAt
    }));
  }

  function size() {
    return entries.size;
  }

  // hydrate 用 Go 的持久化文档回填内存：本进程已经写过的账号保持本地值。
  function hydrate() {
    if (!reader || typeof reader.list !== 'function') return 0;
    let loaded = 0;
    for (const item of reader.list() || []) {
      const ref = normalizeAccountRef(item && item.accountRef);
      const state = normalizeState(item && item.state);
      if (!ref || !state || entries.has(ref)) continue;
      entries.set(ref, { state, updatedAt: Number(item.updatedAt) || 0 });
      loaded += 1;
    }
    return loaded;
  }

  async function pushOne(ref, entry) {
    if (entry.state === null) {
      if (!remove) return true;
      const response = await remove(ref, entry.updatedAt);
      return Boolean(response && response.ok);
    }
    if (!put) return true;
    const response = await put(ref, entry.state, entry.updatedAt);
    return Boolean(response && response.ok);
  }

  // set/clear 只改内存与 dirty，推送在后台进行：调用方（选号器/门禁）是同步路径。
  function set(accountRef, state, updatedAt) {
    const ref = normalizeAccountRef(accountRef);
    const normalized = normalizeState(state);
    if (!ref || !normalized) return false;
    entries.set(ref, { state: normalized, updatedAt: Number(updatedAt) || Date.now() });
    dirty.set(ref, 0);
    scheduleFlush();
    return true;
  }

  // clear 保留一个墓碑条目（state=null）：读方据此知道「该账号在 Go 侧没有文档」，
  // 不会回退到迁移前的旧列；下一次 hydrate 也不会把它补回来。
  function clear(accountRef, updatedAt) {
    const ref = normalizeAccountRef(accountRef);
    if (!ref) return false;
    if (!entries.has(ref) && !dirty.has(ref)) return false;
    entries.set(ref, { state: null, updatedAt: Number(updatedAt) || Date.now() });
    dirty.set(ref, 0);
    scheduleFlush();
    return true;
  }

  // flush 串行推送所有 dirty 条目；失败保留到下一个重试窗口。
  // 并发调用共享同一次推送（flush 期间的新写入在结束后补跑一次）。
  function flush() {
    if (flushPromise) return flushPromise;
    flushPromise = (async () => {
      let pushed = 0;
      let failed = 0;
      let skipped = 0;
      try {
        const now = Date.now();
        for (const [ref, retryAt] of Array.from(dirty.entries())) {
          if (retryAt > now) {
            skipped += 1;
            continue;
          }
          const entry = entries.get(ref) || { state: null, updatedAt: now };
          let ok = false;
          try {
            ok = await pushOne(ref, entry);
          } catch (_error) {
            ok = false;
          }
          if (ok) {
            dirty.delete(ref);
            pushed += 1;
          } else {
            dirty.set(ref, Date.now() + retryMs);
            failed += 1;
          }
        }
      } finally {
        flushPromise = null;
        if (flushQueued) {
          flushQueued = false;
          queueMicrotask(() => { void flush(); });
        }
      }
      return { pushed, failed, skipped };
    })();
    return flushPromise;
  }

  // 推送期间的新写入不能丢：标记一次补跑，避免在失败重试上忙转。
  function scheduleFlush() {
    if (flushPromise) {
      flushQueued = true;
      return;
    }
    void flush();
  }

  return {
    get,
    list,
    size,
    hydrate,
    set,
    clear,
    flush
  };
}

module.exports = {
  createGoRuntimeStateStore
};
