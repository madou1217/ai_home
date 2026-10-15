'use strict';

// 窗口激活调度器：对「滚动限额窗口」类账号定期发一个极小探测，推进/刷新窗口。
//
// 背景：Codex Plus 这类账号的 5 小时限额按滚动窗口计算，窗口只有在账号被真正使用
// 时才会推进。长期不用的账号窗口不前进，下次使用仍卡在旧窗口。这里每隔一段时间
// 用一次账号，把窗口「激活」。
//
// 触发策略是三件事的组合，由 decideActivation 统一裁决：
//   1. 固定周期：距上次探测 >= 间隔（账号自定义优先，否则全局默认）时探测，兜底。
//   2. 活跃时减少：区间内已有真实流量在推进窗口，就跳过，省浪费。
//   3. reset_at 对齐：窗口刚重置时贴近探测，让新窗口尽快开启，更精准。
//
// 能力识别：只有能从用量快照里认出「5h 窗口」（entry.windowMinutes 命中注册表
// windowMatch）且带 resetAtMs 的账号，触发 3 才可用；识别不到就退化为纯固定周期。
// 没有静态的「是否 5h」标志，一律运行时从快照推断。
//
// 探测走 /v1/* 数据面（见 window-activation/probe-dispatch.js），只「像 relay chat
// 一样」用一次账号，绝不建立项目会话。
//
// 写法对齐 lib/server/provider-cli-upgrade-scheduler.js：定时器注入、永不抛、绝不
// 重叠、{start, stop, runNow, getState}。

const {
  getProbeSpec
} = require('./window-activation/probe-specs');
const { resolveProbeModel } = require('./window-activation/probe-model');
const {
  dispatchProbe: defaultDispatchProbe,
  DEFAULT_PROBE_TIMEOUT_MS
} = require('./window-activation/probe-dispatch');
const {
  readWindowActivationConfig,
  readWindowActivationState,
  writeWindowActivationState
} = require('../account/window-activation-store');
const { listAccountQuotaResetEvents } = require('../account/quota-reset-store');
const { isBlockingRuntimeStatus } = require('../account/runtime-view');

const DEFAULT_TICK_INTERVAL_MS = 10 * 60 * 1000; // 每 10 分钟扫一次
const DEFAULT_START_DELAY_MS = 3 * 60 * 1000; // 首轮延后，不与 server 启动抢资源
const DEFAULT_INTERVAL_MS = 4 * 60 * 60 * 1000; // 每账号默认 4 小时用一次
const MIN_INTERVAL_MS = 60 * 60 * 1000; // 间隔下限 1 小时
const MIN_REPROBE_GAP_MS = 45 * 1000; // 同一账号两次探测的最小间隔（防抖）
const PROBE_AHEAD_WINDOW_MS = 5 * 60 * 1000; // 距 reset 点 5 分钟内即视为「已重置」
const DEFAULT_BATCH_SIZE = 4; // 每轮最多探测几个账号

function toMs(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.floor(number) : fallback;
}

function clamp(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(number)));
}

function normalizeWindowActivationConfig(config = {}) {
  const minIntervalMs = Math.max(60_000, toMs(config.minIntervalMs, MIN_INTERVAL_MS));
  return {
    enabled: config.enabled === true,
    minIntervalMs,
    defaultIntervalMs: Math.max(minIntervalMs, toMs(config.defaultIntervalMs, DEFAULT_INTERVAL_MS)),
    tickIntervalMs: Math.max(60_000, toMs(config.tickIntervalMs, DEFAULT_TICK_INTERVAL_MS)),
    startDelayMs: Math.max(0, toMs(config.startDelayMs, DEFAULT_START_DELAY_MS)),
    batchSize: clamp(config.batchSize, 1, 32, DEFAULT_BATCH_SIZE),
    probeTimeoutMs: clamp(config.probeTimeoutMs, 5_000, 120_000, DEFAULT_PROBE_TIMEOUT_MS)
  };
}

function formatError(error) {
  return String((error && error.code) || (error && error.message) || error || 'unknown_error');
}

function unrefTimer(timer) {
  if (timer && typeof timer.unref === 'function') timer.unref();
}

/**
 * 读取某账号最近一次「窗口重置」的发生时刻（毫秒）。
 * 重置事件由 quota-reset-detector 在每次用量快照更新时落盘（手动重置与自然滚动都覆盖），
 * 这里只取最新一条的 occurredAtMs 作为新窗口的起点；读不到就返回 0（退化为只按探测点计时）。
 */
function readLatestQuotaResetAt(fs, aiHomeDir, accountRef) {
  try {
    const events = listAccountQuotaResetEvents(fs, aiHomeDir, accountRef, { limit: 1 });
    const latest = Array.isArray(events) && events.length > 0 ? events[0] : null;
    return latest ? Number(latest.occurredAtMs) || 0 : 0;
  } catch (_resetError) {
    return 0;
  }
}

function listSnapshotEntries(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return [];
  if (Array.isArray(snapshot.entries)) return snapshot.entries;
  if (Array.isArray(snapshot.models)) return snapshot.models;
  return [];
}

/**
 * 能力识别：从快照里找出符合 spec.windowMatch 的窗口项。
 * @returns {object|null}
 */
function findWindowEntry(snapshot, windowMatch) {
  if (!windowMatch || !Number.isFinite(Number(windowMatch.windowMinutes))) return null;
  const target = Number(windowMatch.windowMinutes);
  for (const entry of listSnapshotEntries(snapshot)) {
    const windowMinutes = Number(entry && entry.windowMinutes);
    if (Number.isFinite(windowMinutes) && Math.abs(windowMinutes - target) < 1) {
      return entry;
    }
  }
  return null;
}

/**
 * 纯决策函数（单独导出便于单测）：给定当前时刻与账号事实，判定是否探测。
 *
 * @returns {{action: 'probe'|'skip', trigger: string, resetAtMs?: number}}
 */
function decideActivation(input = {}) {
  const {
    now,
    enabled,
    apiKeyMode,
    status,
    runtimeStatus,
    spec,
    snapshot,
    lastProbeAt = 0,
    lastActivatedAt = 0,
    lastActivityAt = 0,
    lastResetAtMs = 0,
    effectiveIntervalMs = DEFAULT_INTERVAL_MS,
    minReprobeGapMs = MIN_REPROBE_GAP_MS,
    aheadWindowMs = PROBE_AHEAD_WINDOW_MS
  } = input;

  if (!enabled) return { action: 'skip', trigger: 'disabled' };
  if (!spec) return { action: 'skip', trigger: 'no_spec' };
  if (apiKeyMode === true) return { action: 'skip', trigger: 'api_key_account' };
  if (String(status || '').trim().toLowerCase() === 'down') return { action: 'skip', trigger: 'account_down' };
  // 运行态被阻塞（配额耗尽 / 限流 / 鉴权失效）的账号探了也没用：请求会被网关排除并回落到
  // 别的账号（实测 outcome=account_not_matched），白白花掉另一个账号的额度。等窗口重置点
  // 的 reset_aligned 触发再探即可。
  if (isBlockingRuntimeStatus(runtimeStatus)) return { action: 'skip', trigger: 'runtime_blocked' };
  if (now - lastProbeAt < minReprobeGapMs) return { action: 'skip', trigger: 'debounced' };

  const entry = findWindowEntry(snapshot, spec.windowMatch);
  const resetAtMs = entry ? Number(entry.resetAtMs) || 0 : 0;

  // 触发 3：窗口已重置、且我们自那次重置后还没探测过 → 贴近窗口起点探测。
  if (resetAtMs > 0 && now >= resetAtMs - aheadWindowMs && lastProbeAt < resetAtMs) {
    // 若重置后已有真实流量推进了新窗口，则不必再探。
    if (lastActivityAt >= resetAtMs) return { action: 'skip', trigger: 'activity_gate' };
    return { action: 'probe', trigger: 'reset_aligned', resetAtMs };
  }

  // 触发 1 + 2：固定周期，但被「活跃闸门」拦下时跳过。
  //
  // 周期锚点取 max(上次成功激活, 上次窗口重置)：窗口一旦被重置（手动或自动），
  // 新窗口从重置那一刻开始，下一轮就该从重置点重新计时，而不是沿用更早的探测点。
  // 例：间隔 4h、10 分钟前探测过，随后账号被重置 —— 下一轮应为「重置后 4h」，
  // 而不是「上次探测后 4h」（那会早 10 分钟、在刚开的新窗口上浪费一次探测）。
  //
  // 用「上次成功激活」而不是「上次尝试」：探测失败（503/429/池回落）说明这次根本没
  // 用上该账号、窗口没有推进，不该因此把下一次尝试推到一整个间隔之后。
  const anchorAt = Math.max(lastActivatedAt, lastResetAtMs);
  const duePeriodic = now - anchorAt >= effectiveIntervalMs;
  if (!duePeriodic) return { action: 'skip', trigger: 'not_due' };
  // 注意：探测本身也计入 accountActivity，故闸门以「距上次真实活动」而非
  // 「距上次探测」为界；只有真实流量密集到间隔内至少一次时才会长期拦下。
  const recentActivity = lastActivityAt > 0 && now - lastActivityAt < effectiveIntervalMs;
  if (recentActivity) return { action: 'skip', trigger: 'activity_gate' };
  return { action: 'probe', trigger: 'periodic' };
}

function createWindowActivationScheduler(options = {}) {
  const fs = options.fs;
  const aiHomeDir = options.aiHomeDir;
  const setTimeoutFn = typeof options.setTimeoutFn === 'function' ? options.setTimeoutFn : setTimeout;
  const clearTimeoutFn = typeof options.clearTimeoutFn === 'function' ? options.clearTimeoutFn : clearTimeout;
  const setIntervalFn = typeof options.setIntervalFn === 'function' ? options.setIntervalFn : setInterval;
  const clearIntervalFn = typeof options.clearIntervalFn === 'function' ? options.clearIntervalFn : clearInterval;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const logInfo = typeof options.logInfo === 'function' ? options.logInfo : () => {};
  const logWarn = typeof options.logWarn === 'function' ? options.logWarn : () => {};
  const listAccounts = typeof options.listAccounts === 'function' ? options.listAccounts : () => [];
  const accountActivity = options.accountActivity || null;
  const resolveBaseUrl = typeof options.resolveBaseUrl === 'function' ? options.resolveBaseUrl : () => '';
  const clientKey = options.clientKey;
  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : undefined;
  const readConfig = typeof options.readAccountConfig === 'function'
    ? options.readAccountConfig
    : readWindowActivationConfig;
  const readState = typeof options.readAccountState === 'function'
    ? options.readAccountState
    : readWindowActivationState;
  const readLatestResetAt = typeof options.readLatestResetAt === 'function'
    ? options.readLatestResetAt
    : readLatestQuotaResetAt;
  const writeState = typeof options.writeAccountState === 'function'
    ? options.writeAccountState
    : writeWindowActivationState;
  const dispatchProbe = typeof (options.deps && options.deps.dispatchProbe) === 'function'
    ? options.deps.dispatchProbe
    : defaultDispatchProbe;
  // 目标账号可用的模型（探测模型必须从这里解析，见 probe-model.js）。未注入时按「目录未知」处理。
  const listAccountModels = typeof options.listAccountModels === 'function'
    ? options.listAccountModels
    : null;

  const state = {
    running: false,
    cycling: false,
    config: normalizeWindowActivationConfig(options.config),
    timers: { initial: null, interval: null },
    lastResult: null,
    lastError: '',
    tickCount: 0,
    lastProbeMap: new Map(),
    lastActivatedMap: new Map()
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

  function activitySnapshot() {
    try {
      if (accountActivity && typeof accountActivity.snapshot === 'function') {
        return accountActivity.snapshot() || {};
      }
    } catch (_activityError) { /* 活动信号是尽力而为的 */ }
    return {};
  }

  function readLastProbeAt(provider, accountRef) {
    const cached = state.lastProbeMap.get(accountRef);
    if (Number.isFinite(cached)) return cached;
    let persisted = 0;
    try {
      const stored = readState(fs, aiHomeDir, accountRef);
      persisted = stored && Number.isFinite(Number(stored.lastProbeAt)) ? Number(stored.lastProbeAt) : 0;
    } catch (_readError) {
      persisted = 0;
    }
    state.lastProbeMap.set(accountRef, persisted);
    return persisted;
  }

  /**
   * 上次「成功激活」的时刻（周期锚点用它，不用上次尝试）。持久化值优先，内存缓存兜底，
   * 两者都没有时按 0 处理（等价于「还没成功激活过」→ 下一轮就该试）。
   */
  function readLastActivatedAt(accountRef) {
    const cached = state.lastActivatedMap.get(accountRef);
    if (Number.isFinite(cached)) return cached;
    let persisted = 0;
    try {
      const stored = readState(fs, aiHomeDir, accountRef);
      persisted = stored && Number.isFinite(Number(stored.lastActivatedAt)) ? Number(stored.lastActivatedAt) : 0;
    } catch (_readError) {
      persisted = 0;
    }
    state.lastActivatedMap.set(accountRef, persisted);
    return persisted;
  }

  function persistProbeState(accountRef, at, outcome, activated = false) {
    state.lastProbeMap.set(accountRef, at);
    const activatedAt = activated ? at : readLastActivatedAt(accountRef);
    if (activated) state.lastActivatedMap.set(accountRef, at);
    try {
      writeState(fs, aiHomeDir, accountRef, {
        lastProbeAt: at,
        lastActivatedAt: activatedAt,
        lastOutcome: outcome
      }, at);
    } catch (_writeError) { /* 状态是尽力而为的 */ }
  }

  function readAccountModels(accountRef) {
    if (!listAccountModels) return null;
    try {
      return listAccountModels(accountRef) || null;
    } catch (_modelsError) {
      return null;
    }
  }

  async function probeAccount(account, config, decision) {
    const provider = String(account.provider || '').trim().toLowerCase();
    const accountRef = String(account.accountRef || '').trim();
    const spec = getProbeSpec(provider);
    const baseUrl = resolveBaseUrl();
    const at = now();
    // 探测模型必须在该账号自己的目录里：写死的模型一旦被上游下线，网关会在路由层
    // 把该账号排除（快速 503），探测一次都打不到账号上，窗口当然不推进。
    const resolved = resolveProbeModel(spec, readAccountModels(accountRef));
    if (!resolved.model) {
      persistProbeState(accountRef, at, 'no_probe_model');
      return {
        accountRef,
        provider,
        trigger: decision.trigger,
        outcome: 'no_probe_model',
        matched: false,
        model: ''
      };
    }
    let result;
    try {
      result = await dispatchProbe({
        baseUrl,
        clientKey,
        spec,
        provider,
        accountRef,
        model: resolved.model,
        fetchImpl,
        timeoutMs: config.probeTimeoutMs
      });
    } catch (error) {
      result = { ok: false, matched: false, error: formatError(error) };
    }
    const matched = Boolean(result && result.matched);
    // 只有命中目标账号（响应头回填了同一个 accountRef）才算「激活了它的窗口」；
    // 钉选可能被池回落，回落到别的账号不算数。
    const outcome = matched ? 'activated' : (result && result.error ? result.error : 'account_not_matched');
    persistProbeState(accountRef, at, outcome, matched);
    return {
      accountRef,
      provider,
      trigger: decision.trigger,
      outcome,
      matched,
      model: resolved.model
    };
  }

  async function runNow(reason = 'manual') {
    if (!state.config.enabled) return { ok: false, skipped: true, reason: 'disabled' };
    if (state.cycling) return { ok: false, skipped: true, reason: 'already_running' };
    state.cycling = true;
    const config = state.config;
    const probed = [];
    try {
      const accounts = listAccounts();
      const activity = activitySnapshot();
      const currentNow = now();
      const candidates = [];

      for (const account of Array.isArray(accounts) ? accounts : []) {
        if (!account) continue;
        const provider = String(account.provider || '').trim().toLowerCase();
        const accountRef = String(account.accountRef || '').trim();
        if (!accountRef) continue;

        let accountConfig = null;
        try {
          accountConfig = readConfig(fs, aiHomeDir, accountRef);
        } catch (_configError) {
          accountConfig = null;
        }
        const enabled = Boolean(accountConfig && accountConfig.enabled === true);
        const spec = getProbeSpec(provider);
        const effectiveIntervalMs = Math.max(
          config.minIntervalMs,
          toMs(accountConfig && accountConfig.intervalMs, config.defaultIntervalMs)
        );
        const activityEntry = activity[`${provider}:${accountRef}`] || null;
        const decision = decideActivation({
          now: currentNow,
          enabled,
          apiKeyMode: account.apiKeyMode === true,
          status: account.status,
          runtimeStatus: account.runtimeStatus,
          spec,
          snapshot: account.usageSnapshot,
          lastProbeAt: readLastProbeAt(provider, accountRef),
          lastActivatedAt: readLastActivatedAt(accountRef),
          lastActivityAt: Number(activityEntry && activityEntry.lastActivityAt) || 0,
          lastResetAtMs: Number(readLatestResetAt(fs, aiHomeDir, accountRef, provider)) || 0,
          effectiveIntervalMs,
          minReprobeGapMs: MIN_REPROBE_GAP_MS,
          aheadWindowMs: PROBE_AHEAD_WINDOW_MS
        });
        if (decision.action === 'probe') {
          candidates.push({ account, config, decision });
        }
      }

      const batch = candidates.slice(0, config.batchSize);
      for (const item of batch) {
        try {
          probed.push(await probeAccount(item.account, item.config, item.decision));
        } catch (error) {
          // probeAccount 内部已兜底，这里再兜一次，避免一个账号拖垮整轮。
          probed.push({
            accountRef: String(item.account.accountRef || '').trim(),
            provider: String(item.account.provider || '').trim().toLowerCase(),
            trigger: item.decision.trigger,
            outcome: formatError(error),
            matched: false
          });
        }
      }

      state.tickCount += 1;
      state.lastResult = { at: currentNow, reason, probed };
      if (probed.length > 0) {
        const summary = probed.map((item) => `${item.accountRef}=${item.outcome}(${item.trigger})`).join(' ');
        logInfo(`window activation tick (${reason}): ${summary}`);
      }
      return { ok: true, probed };
    } catch (error) {
      const message = formatError(error);
      if (state.lastError !== message) logWarn(`window activation tick failed (${reason}): ${message}`);
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
      runNow('startup').catch((error) => logWarn(`window activation failed (startup): ${formatError(error)}`))
    ), state.config.startDelayMs);
    unrefTimer(state.timers.initial);
    state.timers.interval = setIntervalFn(() => (
      runNow('interval').catch((error) => logWarn(`window activation failed (interval): ${formatError(error)}`))
    ), state.config.tickIntervalMs);
    unrefTimer(state.timers.interval);
  }

  function start(config = {}) {
    state.config = normalizeWindowActivationConfig({ ...state.config, ...config });
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
      defaultIntervalMs: state.config.defaultIntervalMs,
      minIntervalMs: state.config.minIntervalMs,
      tickIntervalMs: state.config.tickIntervalMs,
      batchSize: state.config.batchSize,
      trackedAccounts: state.lastProbeMap.size,
      tickCount: state.tickCount,
      lastResult: state.lastResult,
      lastError: state.lastError
    };
  }

  return { start, stop, runNow, getState };
}

module.exports = {
  DEFAULT_TICK_INTERVAL_MS,
  DEFAULT_START_DELAY_MS,
  DEFAULT_INTERVAL_MS,
  MIN_INTERVAL_MS,
  MIN_REPROBE_GAP_MS,
  PROBE_AHEAD_WINDOW_MS,
  DEFAULT_BATCH_SIZE,
  decideActivation,
  findWindowEntry,
  readLatestQuotaResetAt,
  normalizeWindowActivationConfig,
  createWindowActivationScheduler
};
