'use strict';

const {
  openSseStream,
  writeSseJson,
  broadcastSseJson,
  attachSseWatcher
} = require('./webui-sse-broadcaster');

const hubsByState = new WeakMap();
let fallbackHub = null;

function normalizeTask(task) {
  if (!task || typeof task !== 'object') return null;
  const id = String(task.id || '').trim();
  if (!id) return null;
  return task;
}

function createWebUiTaskHub() {
  const watchers = new Set();
  const sources = new Map();

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
        if (normalized) tasks.set(normalized.id, normalized);
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

  function watch(req, res) {
    openSseStream(res);
    writeSseJson(res, { type: 'connected' });
    writeSseJson(res, { type: 'snapshot', tasks: listActiveTasks() });
    attachSseWatcher(watchers, req, res, {
      heartbeatMs: 30_000,
      onWatcherRemoved: (watcher) => watchers.delete(watcher)
    });
    return true;
  }

  return {
    registerSource,
    listActiveTasks,
    publish,
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
