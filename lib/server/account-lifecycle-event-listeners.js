'use strict';

const nodeFs = require('node:fs');
const nodePath = require('node:path');
const {
  listRefreshableHarnesses,
  refreshHarnessModelProjections
} = require('../harness/model-projection-refresh');
const { readCodexGatewayConnection } = require('./codex-gateway-connection');

// 账号生命周期事件的监听者。
//
// 每个监听者只订阅事实，不关心是谁触发的：新增/导入/删除/启停都会落到
// `account.*`。新增一个消费面 = 在这里多注册一个函数，发布点完全不动。

const DEFAULT_DEBOUNCE_MS = 400;

// 把批量导入产生的 N 个事件合并成一次目录重建；同一时间只跑一轮，
// 期间的再次触发只记一个 pending，跑完再补一次。
function createHarnessModelProjectionListener(deps = {}) {
  const fsImpl = deps.fs || nodeFs;
  const pathImpl = deps.path || nodePath;
  const aiHomeDir = String(deps.aiHomeDir || '').trim();
  const debounceMs = Math.max(0, Number(deps.debounceMs) || DEFAULT_DEBOUNCE_MS);
  const onError = typeof deps.onError === 'function' ? deps.onError : null;
  const refreshImpl = typeof deps.refreshHarnessModelProjections === 'function'
    ? deps.refreshHarnessModelProjections
    : refreshHarnessModelProjections;
  const harnessIds = Array.isArray(deps.harnessIds) && deps.harnessIds.length
    ? deps.harnessIds.map((id) => String(id || '').trim().toLowerCase()).filter(Boolean)
    : listRefreshableHarnesses();

  let timer = null;
  let running = false;
  let pending = false;
  let lastEvent = null;

  function report(error, event) {
    if (onError) {
      try { onError(error, event); } catch (_ignored) {}
      return;
    }
    const provider = String(event && event.provider || '').trim();
    const accountRef = String(event && event.accountRef || '').trim();
    console.warn(`\x1b[33m[aih:models-refresh]\x1b[0m ${provider}#${accountRef}: ${String(error && error.message || error)}`);
  }

  async function run() {
    timer = null;
    if (!aiHomeDir) return;
    if (running) {
      pending = true;
      return;
    }
    running = true;
    const event = lastEvent;
    try {
      const connection = typeof deps.getGatewayConnection === 'function'
        ? deps.getGatewayConnection()
        : readCodexGatewayConnection(fsImpl, aiHomeDir, '');
      if (!connection || !connection.baseUrl || !connection.apiKey) return;
      for (const harnessId of harnessIds) {
        const result = await refreshImpl({
          fs: fsImpl,
          path: pathImpl,
          aiHomeDir,
          harnessId,
          connection,
          fetchImpl: deps.fetchImpl,
          timeoutMs: deps.timeoutMs
        });
        if (result && result.ok && result.updated > 0 && typeof deps.onRefresh === 'function') {
          try { deps.onRefresh(result, event); } catch (_ignored) {}
        }
        if (result && result.ok === false && result.error !== 'gateway_catalog_empty') {
          report(new Error(`${harnessId}: ${result.error}${result.message ? ` (${result.message})` : ''}`), event);
        }
      }
    } catch (error) {
      report(error, event);
    } finally {
      running = false;
      if (pending) {
        pending = false;
        schedule();
      }
    }
  }

  function schedule() {
    if (timer || running) {
      if (running) pending = true;
      return;
    }
    timer = setTimeout(() => { void run(); }, debounceMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  return function onAccountLifecycleChanged(event) {
    lastEvent = event || lastEvent;
    schedule();
  };
}

function registerAccountLifecycleEventListeners(hub, deps = {}) {
  if (!hub || typeof hub.on !== 'function') return [];
  return [
    hub.on('account.*', createHarnessModelProjectionListener(deps))
  ];
}

module.exports = {
  createHarnessModelProjectionListener,
  registerAccountLifecycleEventListeners
};
