'use strict';

const nodeFs = require('node:fs');
const nodePath = require('node:path');
const {
  listRefreshableHarnesses,
  refreshAllHarnessModelProjections
} = require('../harness/model-projection-refresh');
const { ACCOUNT_LIFECYCLE_CHANGED } = require('./account-lifecycle-event-types');
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
  const refreshImpl = typeof deps.refreshModelProjections === 'function'
    ? deps.refreshModelProjections
    : refreshAllHarnessModelProjections;
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
      const outcome = await refreshImpl({
        fs: fsImpl,
        path: pathImpl,
        aiHomeDir,
        harnessIds,
        connection,
        fetchImpl: deps.fetchImpl,
        timeoutMs: deps.timeoutMs
      });
      if (outcome && outcome.ok === false && outcome.error !== 'gateway_catalog_empty') {
        report(new Error(`${outcome.error}${outcome.message ? ` (${outcome.message})` : ''}`), event);
        return;
      }
      for (const result of (outcome && outcome.results) || []) {
        // 即使 updated=0 也回调：一次账号动作只产生一行/每 harness 的日志，
        // 是判断「事件确实到达监听者」的唯一现场证据，而不是每次推理都刷屏。
        if (result && result.ok && typeof deps.onRefresh === 'function') {
          try { deps.onRefresh(result, event); } catch (_ignored) {}
        }
        if (result && result.ok === false && result.error !== 'gateway_catalog_empty') {
          report(new Error(`${result.harness}: ${result.error}${result.message ? ` (${result.message})` : ''}`), event);
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
    // 目录只随「配置层」变化：每次推理成功/限流都会发 account.runtime.changed，
    // 拿它刷模型文件等于给网关自身制造无用请求。这里显式只认生命周期事件，
    // 即使监听者被误挂在 `account.*` 通配上也不会被运行态唤醒。
    if (!event || event.type !== ACCOUNT_LIFECYCLE_CHANGED) return;
    lastEvent = event;
    schedule();
  };
}

function registerAccountLifecycleEventListeners(hub, deps = {}) {
  if (!hub || typeof hub.on !== 'function') return [];
  return [
    hub.on(ACCOUNT_LIFECYCLE_CHANGED, createHarnessModelProjectionListener(deps))
  ];
}

module.exports = {
  createHarnessModelProjectionListener,
  registerAccountLifecycleEventListeners
};
