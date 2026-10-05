'use strict';

// 把存活代次的插件投影推给 Go 数据面，并记下 Go 确认了哪些代次。
//
// Node 是代次的唯一 owner（规划 §5）：转发器只在 Go 确认了某代次之后才带该代次把请求交给 Go，
// 否则请求留在 Node。这里不让发布等待 Go——Go 随时可能重启（重启后它什么投影都没有）：
//   - 代次变化（发布 / 退役）时立即推送全部存活集合（整体替换，幂等）；
//   - 之后按间隔重推，Go 重启后下一轮即恢复确认；推送失败时清空确认集合，请求全部留在 Node；
//   - 宿主接入信息（地址 + 令牌）随投影一起推送，只走 Go 管理接口，不进日志。

const DEFAULT_INTERVAL_MS = 10000;

function createGoProjectionSync({ runtime, push, log = () => {}, intervalMs = DEFAULT_INTERVAL_MS, timers = { setInterval, clearInterval } } = {}) {
  let acked = new Set();
  let inFlight = null;
  let pending = false;
  let timer = null;
  let lastError = '';
  let lastPushAt = 0;

  function payload() {
    const generations = runtime.liveProjections();
    const access = generations.length ? runtime.hostAccess() : null;
    return {
      host: access ? { address: access.address, token: access.token } : { address: '', token: '' },
      generations
    };
  }

  async function pushOnce() {
    const body = payload();
    let result = null;
    try {
      result = await push(body);
    } catch (error) {
      result = { ok: false, errorCode: error && error.message || 'push_failed' };
    }
    lastPushAt = Date.now();
    if (result && result.ok && result.data && Array.isArray(result.data.generations)) {
      acked = new Set(result.data.generations.map(Number));
      lastError = '';
      return;
    }
    if (acked.size) log({ event: 'plugin_projection_unacknowledged', error: String(result && result.errorCode || 'unavailable') });
    acked = new Set();
    lastError = String(result && result.errorCode || 'unavailable');
  }

  // 串行推送；推送进行中又有变化时，结束后再推一次最新集合。
  function sync() {
    if (inFlight) {
      pending = true;
      return inFlight;
    }
    inFlight = pushOnce().finally(() => {
      inFlight = null;
      if (pending) {
        pending = false;
        void sync();
      }
    });
    return inFlight;
  }

  // 只在有存活代次时周期重推（覆盖 Go 重启）；没有插件时不留任何定时器。
  function schedule() {
    const live = runtime.liveProjections().length > 0;
    if (live && !timer) {
      timer = timers.setInterval(() => { void sync(); }, intervalMs);
      timer?.unref?.();
    } else if (!live && timer) {
      timers.clearInterval(timer);
      timer = null;
    }
  }

  const unsubscribe = runtime.onChange(() => {
    // 代次变化的瞬间先撤销对已不存在代次的确认，再推送新集合。
    const live = new Set(runtime.liveProjections().map((item) => item.generation));
    acked = new Set([...acked].filter((generation) => live.has(generation)));
    schedule();
    void sync();
  });

  function start() {
    schedule();
    if (runtime.liveProjections().length) void sync();
  }

  function stop() {
    if (timer) timers.clearInterval(timer);
    timer = null;
    unsubscribe();
  }

  return {
    sync,
    start,
    stop,
    isAcked: (generation) => acked.has(Number(generation)),
    status: () => ({ acknowledged: [...acked].sort((left, right) => left - right), lastError, lastPushAt })
  };
}

module.exports = { createGoProjectionSync };
