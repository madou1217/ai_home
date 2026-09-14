'use strict';

// Provider CLI 自动升级的周期驱动。定时器注入、永不抛、绝不重叠，
// 写法对齐 lib/usage/model-usage-scheduler.js（同一套 {start, stop, runNow, getState} 约定）。
//
// 与 model-usage 扫描的三点不同，都是这件事本身的性质决定的：
//
// 1. **逐个 provider 串行**。安装器要抢 npm 缓存、抢同一个 BIN_DIR；并发跑两个安装
//    只会把互相踩踏的现场留给下一轮去解释。慢不是问题，一轮 6 小时。
//
// 2. **每个 provider 跑完立刻落盘**。一次 apply 是分钟级的（下载 + 安装 + 验证），
//    中途崩掉不能把前面几个 provider 已经确定的结论一起丢掉 —— 账本里
//    knownGoodVersion 和 blockedVersions 正是回滚的唯一依据。
//
// 3. **每个 provider 各自 try/catch**。runner 承诺不抛，但它的依赖是真实世界：
//    checkQuiescence / runPlans / verify 都可能抛。一个 provider 的意外不该让
//    这一轮剩下的 provider 全部不被检查。
//
// 启动延迟取分钟级而不是秒级：首轮会对每个 provider 跑一次基线验证，codex 的强判据要
//    真起一次 app-server（十几秒），不该和 server 启动本身抢资源。

const nodeFs = require('node:fs');
const nodePath = require('node:path');

const { readLedger, writeLedger } = require('./provider-cli-upgrade/upgrade-ledger');
const { runProviderUpgradeCycle } = require('./provider-cli-upgrade/upgrade-runner');
const { listUpgradeCandidateProviders } = require('./provider-cli-upgrade/upgrade-deps');

const DEFAULT_UPGRADE_START_DELAY_MS = 5 * 60 * 1000;
const DEFAULT_UPGRADE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MIN_UPGRADE_INTERVAL_MS = 30 * 60 * 1000;

function normalizePositiveMs(value, fallback, min = 1) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min) return fallback;
  return Math.floor(number);
}

function normalizeProviderCliUpgradeConfig(config = {}) {
  return {
    enabled: config.enabled !== false,
    // 自动应用默认开。这件事确实会动用户的全局环境（见 provider-session-hook-autoinstall.js
    // 头注释记下的那次回退），所以它成立的前提不是「默认值」，而是它外面那几道闸门：
    // 连续两次观测到静默才动手、升完必验、验不过立刻回滚、回滚也失败就熔断该 provider。
    // 关掉的路径一直留着：config.applyEnabled === false 退回只检查、不改动。
    applyEnabled: config.applyEnabled !== false,
    startDelayMs: normalizePositiveMs(config.startDelayMs, DEFAULT_UPGRADE_START_DELAY_MS, 0),
    intervalMs: normalizePositiveMs(config.intervalMs, DEFAULT_UPGRADE_INTERVAL_MS, MIN_UPGRADE_INTERVAL_MS)
  };
}

function formatError(error) {
  return String((error && error.code) || (error && error.message) || error || 'unknown_error');
}

function unrefTimer(timer) {
  if (timer && typeof timer.unref === 'function') timer.unref();
}

function createProviderCliUpgradeScheduler(options = {}) {
  const fs = options.fs || nodeFs;
  const path = options.path || nodePath;
  const processObj = options.processObj || process;
  const aiHomeDir = options.aiHomeDir;
  const deps = options.deps || null;
  const setTimeoutFn = typeof options.setTimeoutFn === 'function' ? options.setTimeoutFn : setTimeout;
  const clearTimeoutFn = typeof options.clearTimeoutFn === 'function' ? options.clearTimeoutFn : clearTimeout;
  const setIntervalFn = typeof options.setIntervalFn === 'function' ? options.setIntervalFn : setInterval;
  const clearIntervalFn = typeof options.clearIntervalFn === 'function' ? options.clearIntervalFn : clearInterval;
  const logInfo = typeof options.logInfo === 'function' ? options.logInfo : () => {};
  const logWarn = typeof options.logWarn === 'function' ? options.logWarn : () => {};
  const readLedgerFn = typeof options.readLedger === 'function' ? options.readLedger : readLedger;
  const writeLedgerFn = typeof options.writeLedger === 'function' ? options.writeLedger : writeLedger;
  const runCycle = typeof options.runCycle === 'function' ? options.runCycle : runProviderUpgradeCycle;
  const providers = Array.isArray(options.providers) && options.providers.length
    ? options.providers.slice()
    : listUpgradeCandidateProviders();

  const state = {
    running: false,
    cycling: false,
    config: normalizeProviderCliUpgradeConfig(options.config),
    timers: { initial: null, interval: null },
    lastResult: null,
    lastError: '',
    tickCount: 0
  };

  function clearTimers() {
    if (state.timers.initial) {
      clearTimeoutFn(state.timers.initial);
      state.timers.initial = null;
    }
    if (state.timers.interval) {
      clearIntervalFn(state.timers.interval);
      state.timers.interval = null;
    }
  }

  function cycleConfig() {
    return {
      applyEnabled: state.config.applyEnabled,
      platform: String(processObj.platform || process.platform),
      env: processObj.env,
      soakMs: options.soakMs,
      soakUnknownLimit: options.soakUnknownLimit
    };
  }

  async function runNow(reason = 'manual') {
    if (!state.config.enabled) return { ok: false, skipped: true, reason: 'disabled' };
    if (!deps) return { ok: false, skipped: true, reason: 'deps_unavailable' };
    if (!providers.length) return { ok: false, skipped: true, reason: 'no_candidates' };
    if (state.cycling) return { ok: false, skipped: true, reason: 'already_running' };

    state.cycling = true;
    const config = cycleConfig();
    const outcomes = {};
    let ledger = readLedgerFn(aiHomeDir, { fs });
    try {
      for (const provider of providers) {
        try {
          const result = await runCycle(provider, ledger, deps, config);
          ledger = result.ledger || ledger;
          outcomes[provider] = { state: result.state || '', reason: result.reason || '' };
        } catch (error) {
          // runner 承诺不抛，但它的依赖来自真实世界；一个 provider 的意外不能吃掉这一轮。
          outcomes[provider] = { state: 'error', reason: formatError(error) };
          const message = `${provider}: ${formatError(error)}`;
          if (state.lastError !== message) logWarn(`provider cli upgrade cycle failed (${message})`);
          state.lastError = message;
        }
        // 逐个落盘：apply 是分钟级动作，中途崩掉不能把前面 provider 的结论一起丢了。
        writeLedgerFn(aiHomeDir, ledger, { fs, path });
      }
      state.tickCount += 1;
      // 这一轮整轮跑完没出岔子就把错误清掉，否则 getState() 会一直挂着几天前的旧故障。
      if (!Object.values(outcomes).some((value) => value.state === 'error')) state.lastError = '';
      state.lastResult = { at: Date.now(), reason, applyEnabled: config.applyEnabled, providers: outcomes };
      const summary = Object.entries(outcomes).map(([provider, value]) => `${provider}=${value.reason}`).join(' ');
      logInfo(`provider cli upgrade tick (${reason}${config.applyEnabled ? '' : ', check-only'}): ${summary}`);
      return { ok: true, providers: outcomes };
    } catch (error) {
      const message = formatError(error);
      if (state.lastError !== message) logWarn(`provider cli upgrade tick failed (${reason}): ${message}`);
      state.lastError = message;
      return { ok: false, error: message };
    } finally {
      state.cycling = false;
    }
  }

  function scheduleTimers() {
    clearTimers();
    if (!state.config.enabled) return;

    state.timers.initial = setTimeoutFn(() => (
      runNow('startup').catch((error) => {
        logWarn(`provider cli upgrade failed (startup): ${formatError(error)}`);
      })
    ), state.config.startDelayMs);
    unrefTimer(state.timers.initial);

    state.timers.interval = setIntervalFn(() => (
      runNow('interval').catch((error) => {
        logWarn(`provider cli upgrade failed (interval): ${formatError(error)}`);
      })
    ), state.config.intervalMs);
    unrefTimer(state.timers.interval);
  }

  function start(config = {}) {
    state.config = normalizeProviderCliUpgradeConfig({ ...state.config, ...config });
    if (state.running) return getState();
    state.running = true;
    scheduleTimers();
    return getState();
  }

  function stop() {
    clearTimers();
    state.running = false;
    return getState();
  }

  function getState() {
    return {
      running: state.running,
      cycling: state.cycling,
      enabled: state.config.enabled,
      applyEnabled: state.config.applyEnabled,
      startDelayMs: state.config.startDelayMs,
      intervalMs: state.config.intervalMs,
      providers: providers.slice(),
      tickCount: state.tickCount,
      lastResult: state.lastResult,
      lastError: state.lastError
    };
  }

  return { start, stop, runNow, getState };
}

module.exports = {
  DEFAULT_UPGRADE_START_DELAY_MS,
  DEFAULT_UPGRADE_INTERVAL_MS,
  MIN_UPGRADE_INTERVAL_MS,
  normalizeProviderCliUpgradeConfig,
  createProviderCliUpgradeScheduler
};
