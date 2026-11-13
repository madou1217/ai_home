'use strict';

// 运行环境作业 → WebUI 全局任务队列的桥。
//
// Go 承接了运行环境作业状态机（/v1/management/webui/toolkit/environments/jobs*），
// 但 /v0/webui/tasks 仍是 Node 的任务中心：它按「源」同步聚合活动任务，并靠
// publish 推送到 SSE 订阅者。这里只做两件事：
//   1. 注册一个只读源，值是最近一次事件流里的作业快照（活动任务才会被列出）；
//   2. 订阅 Go 的全局作业事件流，把每条变更原样交给任务中心。
// 不重新计算状态、不轮询接口：断流时按退避重连，重连后 Go 会先发活动快照。

const { getWebUiTaskHub } = require('./webui-task-hub');

const ACTIVE_STATUSES = new Set(['queued', 'running']);
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30000;

const stateBridges = new WeakMap();
let fallbackBridge = null;

function isActiveJob(job) {
  return Boolean(job && ACTIVE_STATUSES.has(String(job.status || '').toLowerCase()));
}

function normalizeJob(job) {
  if (!job || typeof job !== 'object' || !String(job.id || '').trim()) return null;
  return { ...job, source: 'environment' };
}

function createBridge(ctx) {
  const hub = getWebUiTaskHub(ctx);
  const jobs = new Map();
  const bridge = {
    closed: false,
    controller: null,
    reconnectTimer: null,
    delay: RECONNECT_MIN_MS
  };

  hub.registerSource('environment-go', () => (
    [...jobs.values()].filter(isActiveJob)
  ));

  function applyJob(job) {
    const normalized = normalizeJob(job);
    if (!normalized) return;
    jobs.set(normalized.id, normalized);
    try {
      hub.publish(normalized);
    } catch (_error) {
      // 队列投影失败不能影响作业本身。
    }
  }

  function applySnapshot(list) {
    jobs.clear();
    for (const job of Array.isArray(list) ? list : []) {
      const normalized = normalizeJob(job);
      if (normalized) jobs.set(normalized.id, normalized);
    }
    // 快照即 Go 的活动作业全集：逐个 publish 让任务中心广播最新状态。
    for (const job of jobs.values()) {
      try { hub.publish(job); } catch (_error) {}
    }
  }

  function scheduleReconnect(start) {
    if (bridge.closed) return;
    const delay = bridge.delay;
    bridge.delay = Math.min(delay * 2, RECONNECT_MAX_MS);
    bridge.reconnectTimer = setTimeout(() => {
      bridge.reconnectTimer = null;
      void start();
    }, delay);
    if (typeof bridge.reconnectTimer.unref === 'function') bridge.reconnectTimer.unref();
  }

  async function consume(stream, start) {
    const decoder = new TextDecoder();
    let buffer = '';
    let sawEvent = false;
    for await (const chunk of stream) {
      buffer += decoder.decode(chunk, { stream: true });
      let index = buffer.indexOf('\n\n');
      while (index >= 0) {
        const frame = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const payloadText = line.slice(5).trim();
          if (!payloadText) continue;
          let payload = null;
          try { payload = JSON.parse(payloadText); } catch (_error) { continue; }
          if (payload.type === 'snapshot' && Array.isArray(payload.jobs)) {
            applySnapshot(payload.jobs);
            sawEvent = true;
          } else if (payload.type === 'environment-job' && payload.job) {
            applyJob(payload.job);
            sawEvent = true;
          }
        }
        index = buffer.indexOf('\n\n');
      }
    }
    if (sawEvent) bridge.delay = RECONNECT_MIN_MS;
    scheduleReconnect(start);
  }

  async function start() {
    if (bridge.closed) return;
    const goHost = ctx && ctx.deps && ctx.deps.goCoreSync;
    if (!goHost || typeof goHost.watchToolkitEnvironmentJobs !== 'function') {
      scheduleReconnect(start);
      return;
    }
    const result = await goHost.watchToolkitEnvironmentJobs().catch(() => null);
    if (!result || !result.ok || !result.body) {
      scheduleReconnect(start);
      return;
    }
    bridge.controller = { abort: result.abort };
    try {
      await consume(result.body, start);
    } catch (_error) {
      if (sawAbort(_error)) return;
      scheduleReconnect(start);
    }
  }

  function sawAbort(error) {
    return String(error && error.name || '') === 'AbortError';
  }

  bridge.close = () => {
    bridge.closed = true;
    if (bridge.reconnectTimer) clearTimeout(bridge.reconnectTimer);
    bridge.reconnectTimer = null;
    try { bridge.controller?.abort?.(); } catch (_error) {}
  };

  void start();
  return bridge;
}

function ensureEnvironmentJobBridge(ctx) {
  const owner = ctx && ctx.state;
  if (owner && typeof owner === 'object') {
    if (stateBridges.has(owner)) return stateBridges.get(owner);
    const bridge = createBridge(ctx);
    stateBridges.set(owner, bridge);
    return bridge;
  }
  if (!fallbackBridge) fallbackBridge = createBridge(ctx);
  return fallbackBridge;
}

// 单条作业快照（执行响应 / GET job）立即投影，避免等事件流往返。
function publishEnvironmentJob(ctx, job) {
  if (!job || typeof job !== 'object' || !String(job.id || '').trim()) return;
  try {
    ensureEnvironmentJobBridge(ctx);
    getWebUiTaskHub(ctx).publish({ ...job, source: 'environment' });
  } catch (_error) {
    // 投影失败不影响作业结果。
  }
}

module.exports = {
  ensureEnvironmentJobBridge,
  publishEnvironmentJob
};
