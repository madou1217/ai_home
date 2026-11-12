'use strict';

const {
  openSseStream,
  writeSseJson,
  broadcastSseJson,
  attachSseWatcher
} = require('./webui-sse-broadcaster');
const {
  createTaskEvent,
  createTaskEventBuffer
} = require('./webui-task-events');

const hubsByState = new WeakMap();
let fallbackHub = null;
const ACTIVE_STATUSES = new Set(['queued', 'running']);

function normalizeTask(task) {
  if (!task || typeof task !== 'object') return null;
  const id = String(task.id || '').trim();
  if (!id) return null;
  return task;
}

function isActiveStatus(status) {
  return ACTIVE_STATUSES.has(String(status || ''));
}

function createWebUiTaskHub() {
  const watchers = new Set();
  const sources = new Map();
  // 事件流与任务快照分开：快照回答「有哪些任务」，事件回答「执行到哪一步」。
  // 重连时先给快照，再补最近事件，页面无需轮询任务详情。
  const eventBuffer = createTaskEventBuffer();

  function registerSource(id, listActiveTasks) {
    const sourceId = String(id || '').trim();
    if (!sourceId || typeof listActiveTasks !== 'function') return () => {};
    sources.set(sourceId, listActiveTasks);
    return () => {
      if (sources.get(sourceId) === listActiveTasks) sources.delete(sourceId);
    };
  }

  function listActiveTasks() {
    const tasks = new Map();
    for (const listSource of sources.values()) {
      let sourceTasks = [];
      try {
        sourceTasks = listSource() || [];
      } catch (_error) {
        sourceTasks = [];
      }
      for (const task of sourceTasks) {
        const normalized = normalizeTask(task);
        if (normalized && isActiveStatus(normalized.status)) {
          tasks.set(normalized.id, normalized);
        }
      }
    }
    return [...tasks.values()].sort((left, right) => {
      const leftCreated = Number(left.createdAt || 0);
      const rightCreated = Number(right.createdAt || 0);
      return leftCreated - rightCreated || String(left.id).localeCompare(String(right.id));
    });
  }

  function publish(task) {
    const normalized = normalizeTask(task);
    if (!normalized) return;
    broadcastSseJson(watchers, { type: 'task', task: normalized }, {
      onWatcherRemoved: (watcher) => watchers.delete(watcher)
    });
  }

  /**
   * 广播一条阶段事件。event 由 job manager 生成（含 taskId/seq/at/phase/message/account）。
   * 这里只做归一化与缓存，不重新解释 phase。
   */
  function publishEvent(input) {
    const event = createTaskEvent(input);
    if (!event) return null;
    eventBuffer.append(event);
    broadcastSseJson(watchers, { type: 'task-event', event }, {
      onWatcherRemoved: (watcher) => watchers.delete(watcher)
    });
    return event;
  }

  function listRecentEvents() {
    return eventBuffer.listAll();
  }

  function watch(req, res) {
    openSseStream(res);
    writeSseJson(res, { type: 'connected' });
    writeSseJson(res, { type: 'snapshot', tasks: listActiveTasks() });
    // 事件快照必须紧跟在任务快照之后：先有任务集合，再补最近执行轨迹。
    writeSseJson(res, { type: 'event-snapshot', events: listRecentEvents() });
    attachSseWatcher(watchers, req, res, {
      heartbeatMs: 30_000,
      onWatcherRemoved: (watcher) => watchers.delete(watcher)
    });
    return true;
  }

  return {
    registerSource,
    listActiveTasks,
    listRecentEvents,
    publish,
    publishEvent,
    watch
  };
}

function getWebUiTaskHub(ctx = {}) {
  if (ctx.deps && ctx.deps.webUiTaskHub) return ctx.deps.webUiTaskHub;
  if (ctx.state && typeof ctx.state === 'object') {
    const cached = hubsByState.get(ctx.state);
    if (cached) return cached;
    const hub = createWebUiTaskHub();
    hubsByState.set(ctx.state, hub);
    return hub;
  }
  if (!fallbackHub) fallbackHub = createWebUiTaskHub();
  return fallbackHub;
}

module.exports = {
  createWebUiTaskHub,
  getWebUiTaskHub
};
