'use strict';

// 远程备份的自动调度。
//
// 两条触发线：
//   1. 账号生命周期事件（新增/导入/同身份换凭据/删除/启停）→ 去抖后立即备份；
//   2. 周期 tick → 按 intervalMinutes 补一轮（覆盖 token 刷新等不产生生命周期事件的变化）。
//
// 单飞 + pending：一轮没跑完时再次触发只记一个 pending，跑完补一次，绝不并发写同一目标。

const fs = require('node:fs');

const { readBackupConfig, readBackupState } = require('./remote-backup-config');
const { runRemoteBackup } = require('./remote-backup-service');

const DEFAULT_TICK_MS = 60 * 1000;
const STARTUP_DELAY_MS = 5 * 1000;
const RETRY_AFTER_FAILURE_MS = 5 * 60 * 1000;
const DEFAULT_DEBOUNCE_SECONDS = 30;

function nonEmptyString(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function timestamp(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function createLogger(logger) {
  if (logger && typeof logger.info === 'function') return logger;
  return {
    info: (message) => console.log(`\x1b[36m[aih:backup]\x1b[0m ${message}`),
    warn: (message) => console.warn(`\x1b[33m[aih:backup]\x1b[0m ${message}`)
  };
}

function dueTargetIds(config, state, at) {
  const intervalMs = Math.max(1, Number(config.intervalMinutes) || 0) * 60 * 1000;
  const ids = [];
  for (const target of config.targets || []) {
    if (!target.enabled) continue;
    const entry = state.targets && state.targets[target.id];
    if (!entry || !entry.lastRunAt) {
      ids.push(target.id);
      continue;
    }
    if (entry.lastError) {
      if (at - timestamp(entry.lastRunAt) >= RETRY_AFTER_FAILURE_MS) ids.push(target.id);
      continue;
    }
    if (at - timestamp(entry.lastOkAt || entry.lastRunAt) >= intervalMs) ids.push(target.id);
  }
  return ids;
}

function createRemoteBackupScheduler(options = {}) {
  const fsImpl = options.fs || fs;
  const aiHomeDir = nonEmptyString(options.aiHomeDir);
  const logger = createLogger(options.logger);
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const runBackup = typeof options.runBackup === 'function' ? options.runBackup : runRemoteBackup;
  const tickMs = Math.max(1000, Number(options.tickMs) || DEFAULT_TICK_MS);
  const startupDelayMs = Math.max(0, Number(options.startupDelayMs ?? STARTUP_DELAY_MS));

  let tickTimer = null;
  let startupTimer = null;
  let debounceTimer = null;
  let running = false;
  let pending = null;
  let stopped = false;

  function schedulePending() {
    if (!pending) return;
    const next = pending;
    pending = null;
    const timer = setTimeout(() => {
      void run(next.reason, { force: next.force, targetIds: next.targetIds });
    }, 0);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  async function run(reason, runOptions = {}) {
    if (stopped || !aiHomeDir) return { ok: true, skipped: 'stopped' };
    if (running) {
      pending = {
        reason,
        force: Boolean(runOptions.force),
        targetIds: Array.isArray(runOptions.targetIds) ? runOptions.targetIds : []
      };
      return { ok: true, skipped: 'running' };
    }
    running = true;
    try {
      const config = readBackupConfig({ fs: fsImpl, aiHomeDir });
      if (!config.enabled) return { ok: true, skipped: 'disabled' };
      if (!config.targets.some((target) => target.enabled)) return { ok: true, skipped: 'no_targets' };
      const state = readBackupState({ fs: fsImpl, aiHomeDir });
      const requested = Array.isArray(runOptions.targetIds) && runOptions.targetIds.length
        ? runOptions.targetIds
        : [];
      const ids = requested.length > 0
        ? requested
        : (runOptions.force ? [] : dueTargetIds(config, state, now()));
      if (!requested.length && !runOptions.force && ids.length === 0) {
        return { ok: true, skipped: 'not_due' };
      }
      const result = await runBackup({
        fs: fsImpl,
        aiHomeDir,
        config,
        state,
        targetIds: requested.length > 0 ? requested : ids,
        full: Boolean(runOptions.full),
        logger,
        now
      });
      if (!result.ok) logger.warn(`自动备份部分目标失败（${reason}）`);
      return result;
    } catch (error) {
      logger.warn(`自动备份失败（${reason}）：${String(error && (error.code || error.message) || error).slice(0, 300)}`);
      return { ok: false, error: String(error && (error.code || error.message) || error).slice(0, 300) };
    } finally {
      running = false;
      schedulePending();
    }
  }

  function trigger(reason = 'event') {
    if (stopped || !aiHomeDir) return false;
    if (debounceTimer) return true;
    let debounceSeconds = DEFAULT_DEBOUNCE_SECONDS;
    try {
      const config = readBackupConfig({ fs: fsImpl, aiHomeDir });
      if (!config.enabled) return false;
      if (!config.targets.some((target) => target.enabled)) return false;
      debounceSeconds = Number(config.debounceSeconds);
      if (!Number.isFinite(debounceSeconds) || debounceSeconds < 0) debounceSeconds = DEFAULT_DEBOUNCE_SECONDS;
    } catch (_error) {
      return false;
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void run(reason, { force: true });
    }, Math.max(0, debounceSeconds) * 1000);
    if (debounceTimer && typeof debounceTimer.unref === 'function') debounceTimer.unref();
    return true;
  }

  function start() {
    if (stopped) return false;
    if (startupTimer || tickTimer) return true;
    if (startupDelayMs > 0) {
      startupTimer = setTimeout(() => {
        startupTimer = null;
        void run('startup');
      }, startupDelayMs);
      if (startupTimer && typeof startupTimer.unref === 'function') startupTimer.unref();
    }
    tickTimer = setInterval(() => { void run('interval'); }, tickMs);
    if (tickTimer && typeof tickTimer.unref === 'function') tickTimer.unref();
    return true;
  }

  function stop() {
    stopped = true;
    if (startupTimer) clearTimeout(startupTimer);
    if (tickTimer) clearInterval(tickTimer);
    if (debounceTimer) clearTimeout(debounceTimer);
    startupTimer = null;
    tickTimer = null;
    debounceTimer = null;
    pending = null;
  }

  return {
    start,
    stop,
    trigger,
    runNow: (runOptions = {}) => run('manual', { ...runOptions, force: true }),
    runDue: () => run('interval'),
    isRunning: () => running,
    dueTargetIds: (config, state) => dueTargetIds(config, state, now())
  };
}

module.exports = {
  DEFAULT_TICK_MS,
  RETRY_AFTER_FAILURE_MS,
  createRemoteBackupScheduler,
  dueTargetIds
};
