'use strict';

// 窗口激活调度器：让滚动限额窗口（Codex Plus 的 5h 等）持续滚动。
//
// 需求（2026-10-16 用户口径）：窗口只在账号被使用时才前进 —— 窗口关着时用户开口 =
// 从零开始等满 5 小时；窗口已经跑起来时开口，用完后平均只需等 1 小时。所以本功能的
// 目标不是「到点续窗」本身，而是「任何时刻窗口都尽量处在滚动中」。
//
// 上游事实（2026-10-16 本机取证）见 window-ledger.js 头部与规划文档
// docs/plans/2026-10-16-window-activation-redesign.md：
//   F1 窗口由「关闭后的第一个请求」锚定，reset = 锚点 + 窗口时长，秒级精确；
//   F2 窗口期内请求不移动锚点 → 知道锚点就等于知道关窗时刻（确定值，与快照新鲜度无关）；
//   F3 窗口关闭且无人使用时，快照报「读取时刻 + 窗口时长」（幻影值），与真窗口形态一致；
//   F4 只有真实请求会开窗，纯只读（用量刷新）不会。
//
// 触发模型 = 账本 + 关窗即续 + 幻影检测：
//   · 窗口运行中（now < closeAtMs）→ 一次都不探（窗口期内探测是空操作，纯烧 token）；
//   · 关窗时刻一过（+ 时钟余量）且关窗后没有用户流量 → 补一次极小探测（唯一动作）；
//   · 观察到「没有活跃窗口」（幻影 / 快照确认）→ 立刻补窗，不等周期；
//   · 窗口状态观察不出来（快照缺失、provider 没有 resetAtMs）→ 固定间隔兜底。
//
// 旧设计的 reset_at 对齐（「距 reset 5 分钟内探测」）已删除：幻影的 reset 永远在未来，
// 对齐触发会永久 not_due；且提前探测会打进旧窗口白探（2026-10-16 实测 gmail 账号因此
// 空窗 67 分钟，见规划文档 §3）。
//
// 探测走 /v1/* 数据面（见 window-activation/probe-dispatch.js），只「像 relay chat
// 一样」用一次账号，绝不建立项目会话。
//
// 写法对齐 lib/server/provider-cli-upgrade-scheduler.js：定时器注入、永不抛、绝不重叠、
// {start, stop, runNow, getState}。

const { getProbeSpec } = require('./window-activation/probe-specs');
const { resolveProbeModel } = require('./window-activation/probe-model');
const {
  dispatchProbe: defaultDispatchProbe,
  DEFAULT_PROBE_TIMEOUT_MS
} = require('./window-activation/probe-dispatch');
const {
  findWindowEntry,
  normalizeLedger,
  observeWindow,
  reconcileLedger,
  describeWindowView,
  anchorWindowAt,
  clearProbeFailure,
  markProbeFailure,
  PROBE_GRACE_MS,
  PROBE_RETRY_BACKOFF_MS,
  ACTIVITY_EPS_MS
} = require('./window-activation/window-ledger');
const {
  readWindowActivationConfig,
  readWindowActivationState,
  writeWindowActivationState
} = require('../account/window-activation-store');
const { isBlockingRuntimeStatus } = require('../account/runtime-view');

const DEFAULT_TICK_INTERVAL_MS = 10 * 60 * 1000; // 每 10 分钟扫一次（关窗后最多 10 分钟续上）
const DEFAULT_START_DELAY_MS = 3 * 60 * 1000; // 首轮延后，不与 server 启动抢资源
// 兜底间隔：只在「窗口状态观察不出来」时使用（能观察到的账号按关窗时刻续窗，不看它）。
// 1 小时 = 下限：把兜底节奏也钉在下限上，因为比窗口时长更密的探测不产生任何收益。
const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;
const MIN_INTERVAL_MS = 60 * 60 * 1000;
const MIN_REPROBE_GAP_MS = 45 * 1000; // 同一账号两次探测的最小间隔（防抖）
const DEFAULT_BATCH_SIZE = 4; // 每轮最多探测几个账号
// 慢退避失败：探测根本没落到目标账号上（池回落）或压根发不出去（没有可用探测模型）。
// 这两类 10 分钟内不会有变化，按兜底间隔重试，免得每次失败都白花别的账号的额度。
const SLOW_RETRY_OUTCOMES = new Set(['account_not_matched', 'no_probe_model']);

// 落盘记录里参与「内容是否变化」比较的字段（updatedAt 不算，否则每轮都会写库）。
const STATE_RECORD_FIELDS = [
  'lastProbeAt',
  'lastActivatedAt',
  'lastOutcome',
  'windowAnchorAtMs',
  'windowMinutes',
  'windowCloseAtMs',
  'windowSource',
  'windowObservedAtMs',
  'probeFailureCount',
  'lastDecisionAction',
  'lastDecisionReason',
  'lastDecisionAtMs'
];

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

function formatClock(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return '';
  try {
    return new Date(value).toTimeString().slice(0, 8);
  } catch (_clockError) {
    return '';
  }
}

function unrefTimer(timer) {
  if (timer && typeof timer.unref === 'function') timer.unref();
}

function stateRecordsEqual(previous, next) {
  if (!previous || !next) return false;
  return STATE_RECORD_FIELDS.every(
    (field) => String(previous[field] === undefined || previous[field] === null ? '' : previous[field])
      === String(next[field] === undefined || next[field] === null ? '' : next[field])
  );
}

/**
 * 纯决策函数（单独导出便于单测）：给定「窗口视图 + 账号事实」判定是否探测。
 *
 * 触发（trigger）语义：
 *   window_open               窗口运行中 → 跳过（唯一「什么都不做」的正常态）
 *   window_closed             关窗时刻已过且没人用 → 探测续窗（核心动作）
 *   window_absent             观察到「没有活跃窗口」（幻影）→ 探测补窗
 *   user_reopened             关窗后有用户自己的流量（用户已开新窗）→ 只重锚账本
 *   close_grace               关窗时刻刚过（< 时钟余量）→ 等等再探
 *   probe_retry_backoff       上一轮探测失败 → 按退避重试
 *   periodic_fallback        窗口状态观察不出来 → 固定间隔兜底
 *   activity_gate             兜底分支里区间内有真实流量 → 跳过
 *   not_due / debounced / disabled / no_spec / api_key_account / account_down /
 *   runtime_blocked / probe_pending_observation   其余跳过原因
 *
 * @returns {{action: 'probe'|'skip', trigger: string, [key: string]: *}}
 */
function decideActivation(input = {}) {
  const {
    now,
    enabled,
    apiKeyMode,
    status,
    runtimeStatus,
    runtimeReason,
    spec,
    view,
    ledger,
    lastProbeAt = 0,
    lastActivatedAt = 0,
    lastActivityAt = 0,
    lastOutcome = '',
    effectiveIntervalMs = DEFAULT_INTERVAL_MS,
    minReprobeGapMs = MIN_REPROBE_GAP_MS,
    probeGraceMs = PROBE_GRACE_MS,
    retryBackoffMs = PROBE_RETRY_BACKOFF_MS,
    activityEpsMs = ACTIVITY_EPS_MS
  } = input;

  if (!enabled) return { action: 'skip', trigger: 'disabled' };
  if (!spec) return { action: 'skip', trigger: 'no_spec' };
  if (apiKeyMode === true) return { action: 'skip', trigger: 'api_key_account' };
  if (String(status || '').trim().toLowerCase() === 'down') return { action: 'skip', trigger: 'account_down' };
  // 运行态被阻塞（配额耗尽 / 限流 / 鉴权失效）的账号探了也没用：请求会被网关排除并回落到
  // 别的账号，白白花掉另一个账号的额度。这里「跳过但可见」：
  //   · 额度类阻塞（quota_exhausted）由 account-quota-probe-scheduler 的用量刷新自动解除
  //     （它在 reset 前后每分钟重读快照），解除后的下一个 tick 就轮到 window_closed/window_absent；
  //   · 鉴权/权限类阻塞本质不可由探测修复 → 一直跳过，但账号页能看到原因（不再「看起来开着」）。
  if (isBlockingRuntimeStatus(runtimeStatus)) {
    return {
      action: 'skip',
      trigger: 'runtime_blocked',
      runtimeStatus: String(runtimeStatus || '').trim().toLowerCase(),
      runtimeReason: String(runtimeReason || '').trim()
    };
  }
  if (now - lastProbeAt < minReprobeGapMs) return { action: 'skip', trigger: 'debounced' };
  const failureCount = Math.max(0, toMs(ledger && ledger.probeFailureCount, 0));
  if (failureCount > 0) {
    const outcome = String(lastOutcome || '').trim();
    const backoffMs = SLOW_RETRY_OUTCOMES.has(outcome)
      ? effectiveIntervalMs
      : Math.min(effectiveIntervalMs, retryBackoffMs * failureCount);
    const waitedMs = now - lastProbeAt;
    if (waitedMs < backoffMs) {
      return { action: 'skip', trigger: 'probe_retry_backoff', retryInMs: backoffMs - waitedMs };
    }
  }

  const windowView = view || describeWindowView(ledger, now);

  if (windowView.kind === 'open') {
    // 窗口运行中：一次都不探。窗口期内探测是空操作（F2），只会白烧 token。
    return {
      action: 'skip',
      trigger: 'window_open',
      closeAtMs: toMs(windowView.closeAtMs, 0),
      remainingMs: Math.max(0, toMs(windowView.closeAtMs, 0) - now)
    };
  }

  if (windowView.kind === 'closed') {
    const closeAtMs = toMs(windowView.closeAtMs, 0);
    // 关窗之后已经有真实流量（且最后一次活动不是我们自己的探测）→ 用户自己开了新窗，
    // 把账本按那次活动重锚即可，不需要再探。
    const userReopenedAt = (closeAtMs > 0 && lastActivityAt > closeAtMs
      && lastActivityAt - lastProbeAt > activityEpsMs)
      ? lastActivityAt
      : 0;
    if (userReopenedAt > 0) {
      return { action: 'skip', trigger: 'user_reopened', reanchorAtMs: userReopenedAt, closeAtMs };
    }
    if (now < closeAtMs + probeGraceMs) {
      return { action: 'skip', trigger: 'close_grace', closeAtMs, probeAtMs: closeAtMs + probeGraceMs };
    }
    return { action: 'probe', trigger: 'window_closed', closeAtMs };
  }

  if (windowView.kind === 'absent') {
    const observedAtMs = toMs(windowView.observedAtMs, 0);
    // 观察到「没有活跃窗口」之后已经成功探测过一次（那次探测的锚点本该写进账本）；
    // 还停在这个视图说明账本没写成功 —— 等下一张快照/下一轮对账，别在同一事实下反复探。
    if (lastActivatedAt > observedAtMs) {
      return { action: 'skip', trigger: 'probe_pending_observation', observedAtMs };
    }
    return { action: 'probe', trigger: 'window_absent', observedAtMs };
  }

  // unknown：观察不出窗口（快照缺失 / 该 provider 没有 resetAtMs / 旧记录）→ 固定间隔兜底。
  // 周期锚点取 max(上次成功激活, 账本锚点)：窗口一旦被重开，下一轮从新窗口起点计时。
  const anchorAt = Math.max(toMs(lastActivatedAt, 0), toMs(ledger && ledger.windowAnchorAtMs, 0));
  if (now - anchorAt < effectiveIntervalMs) return { action: 'skip', trigger: 'not_due' };
  // 注意：探测本身也计入 accountActivity，故闸门以「距上次真实活动」而非「距上次探测」为界。
  const recentActivity = lastActivityAt > 0 && now - lastActivityAt < effectiveIntervalMs;
  if (recentActivity) return { action: 'skip', trigger: 'activity_gate' };
  return { action: 'probe', trigger: 'periodic_fallback' };
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
    // 进程内写过的账号状态（落盘是尽力而为的，这里保住「刚探过」这个事实用于防抖/退避）。
    lastProbeMap: new Map(),
    lastActivatedMap: new Map(),
    // 最近一轮每个账号的窗口视图与判定（可观测性）。
    lastViews: new Map()
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

  function readStoredState(accountRef) {
    try {
      return readState(fs, aiHomeDir, accountRef) || null;
    } catch (_readError) {
      return null;
    }
  }

  function readAccountModels(accountRef) {
    if (!listAccountModels) return null;
    try {
      return listAccountModels(accountRef) || null;
    } catch (_modelsError) {
      return null;
    }
  }

  /**
   * 把账本 + 判定 + 探测结果合成完整落盘记录。lastDecisionAtMs 只在「判定本身变化」时
   * 更新，这样稳定态下账本内容不变 → 不写库（每 10 分钟一轮，别每轮都写）。
   */
  function buildStateRecord(stored, ledger, decision, timing) {
    const previous = stored || {};
    const reasonChanged = String(previous.lastDecisionAction || '') !== decision.action
      || String(previous.lastDecisionReason || '') !== decision.trigger;
    return {
      lastProbeAt: Math.max(toMs(timing.lastProbeAt, 0), toMs(previous.lastProbeAt, 0)),
      lastActivatedAt: Math.max(toMs(timing.lastActivatedAt, 0), toMs(previous.lastActivatedAt, 0)),
      lastOutcome: typeof timing.lastOutcome === 'string' ? timing.lastOutcome : String(previous.lastOutcome || ''),
      windowAnchorAtMs: toMs(ledger.windowAnchorAtMs, 0),
      windowMinutes: toMs(ledger.windowMinutes, 0),
      windowCloseAtMs: toMs(ledger.windowCloseAtMs, 0),
      windowSource: String(ledger.windowSource || ''),
      windowObservedAtMs: toMs(ledger.windowObservedAtMs, 0),
      probeFailureCount: toMs(ledger.probeFailureCount, 0),
      lastDecisionAction: decision.action,
      lastDecisionReason: decision.trigger,
      lastDecisionAtMs: reasonChanged ? timing.now : toMs(previous.lastDecisionAtMs, 0)
    };
  }

  function persistAccountState(accountRef, record) {
    state.lastProbeMap.set(accountRef, record.lastProbeAt);
    if (record.lastActivatedAt > 0) state.lastActivatedMap.set(accountRef, record.lastActivatedAt);
    try {
      writeState(fs, aiHomeDir, accountRef, record, record.lastProbeAt || now());
    } catch (_writeError) { /* 状态是尽力而为的 */ }
  }

  /**
   * 一个账号的完整探测流程：解析模型 → 派发 → 按结果推进/不推进账本 → 落盘。
   * 只在「窗口已确认关闭/缺失」时把账本锚定到探测时刻（见 window-ledger.anchorWindowAt）。
   */
  async function probeAccount(item) {
    const { account, decision, ledger, stored, lastActivatedAt } = item;
    const provider = String(account.provider || '').trim().toLowerCase();
    const accountRef = String(account.accountRef || '').trim();
    const spec = getProbeSpec(provider);
    const at = now();
    const resolved = resolveProbeModel(spec, readAccountModels(accountRef));
    if (!resolved.model) {
      const record = buildStateRecord(stored, markProbeFailure(ledger), decision, {
        now: at,
        lastProbeAt: at,
        lastActivatedAt,
        lastOutcome: 'no_probe_model'
      });
      persistAccountState(accountRef, record);
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
        baseUrl: resolveBaseUrl(),
        clientKey,
        spec,
        provider,
        accountRef,
        model: resolved.model,
        fetchImpl,
        timeoutMs: state.config.probeTimeoutMs
      });
    } catch (error) {
      result = { ok: false, matched: false, error: formatError(error) };
    }
    const matched = Boolean(result && result.matched);
    const ok = Boolean(result && result.ok);
    const success = matched && ok;
    // 只有「命中目标账号（响应头回填同一个 accountRef）且请求成功」才算真的续上了窗口；
    // 钉选被池回落、或打到了账号但上游报错，都不算，也都不推进账本（旧实现把 matched
    // 当成功，会把周期锚点推错）。
    const outcome = success
      ? 'activated'
      : (matched
        ? 'matched_upstream_error'
        : (String(result && result.error || '').trim() || 'account_not_matched'));
    const canAnchor = decision.trigger === 'window_closed' || decision.trigger === 'window_absent';
    // 成功探测必清零失败计数（含不锚定账本的兜底分支）；失败才累积退避计数。
    let nextLedger;
    if (!success) {
      nextLedger = markProbeFailure(ledger);
    } else if (canAnchor) {
      nextLedger = anchorWindowAt(
        ledger,
        at,
        ledger.windowMinutes || toMs(spec && spec.windowMatch && spec.windowMatch.windowMinutes, 0),
        'probe'
      );
    } else {
      nextLedger = clearProbeFailure(ledger);
    }
    const record = buildStateRecord(stored, nextLedger, decision, {
      now: at,
      lastProbeAt: at,
      // 每次成功都推进「上次成功激活」：它同时是兜底分支（观察不出窗口时）的周期锚点，
      // 不推进会让兜底分支每 10 分钟重复探测。账本锚定则只在窗口已确认关闭/缺失时进行。
      lastActivatedAt: success ? at : lastActivatedAt,
      lastOutcome: outcome
    });
    persistAccountState(accountRef, record);
    return {
      accountRef,
      provider,
      trigger: decision.trigger,
      outcome,
      matched,
      model: resolved.model,
      httpStatus: Number.isInteger(result && result.httpStatus) ? result.httpStatus : null
    };
  }

  async function runNow(reason = 'manual') {
    if (!state.config.enabled) return { ok: false, skipped: true, reason: 'disabled' };
    if (state.cycling) return { ok: false, skipped: true, reason: 'already_running' };
    state.cycling = true;
    const config = state.config;
    const probed = [];
    const decisions = [];
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
        // 未开启的账号不做任何计算（也不读状态）：绝大多数账号走这条路径。
        if (!(accountConfig && accountConfig.enabled === true)) continue;

        const spec = getProbeSpec(provider);
        const effectiveIntervalMs = Math.max(
          config.minIntervalMs,
          toMs(accountConfig && accountConfig.intervalMs, config.defaultIntervalMs)
        );
        const activityEntry = activity[`${provider}:${accountRef}`] || null;
        const stored = readStoredState(accountRef) || {};
        const lastProbeAt = Math.max(
          toMs(stored.lastProbeAt, 0),
          toMs(state.lastProbeMap.get(accountRef), 0)
        );
        const lastActivatedAt = Math.max(
          toMs(stored.lastActivatedAt, 0),
          toMs(state.lastActivatedMap.get(accountRef), 0)
        );
        const lastActivityAt = Number(activityEntry && activityEntry.lastActivityAt) || 0;

        // 对账：快照观察（live/absent/unknown）合并进账本；账本自带关窗时刻，
        // 所以「关窗了没有」不依赖快照新鲜度。
        const observation = observeWindow(account.usageSnapshot, spec, { now: currentNow, lastProbeAt });
        const reconciled = reconcileLedger(normalizeLedger(stored), observation);
        const view = describeWindowView(reconciled, currentNow);
        const decision = decideActivation({
          now: currentNow,
          enabled: true,
          apiKeyMode: account.apiKeyMode === true,
          status: account.status,
          runtimeStatus: account.runtimeStatus,
          runtimeReason: account.runtimeReason,
          spec,
          view,
          ledger: reconciled,
          lastProbeAt,
          lastActivatedAt,
          lastActivityAt,
          lastOutcome: stored.lastOutcome,
          effectiveIntervalMs,
          minReprobeGapMs: MIN_REPROBE_GAP_MS,
          probeGraceMs: PROBE_GRACE_MS,
          retryBackoffMs: PROBE_RETRY_BACKOFF_MS,
          activityEpsMs: ACTIVITY_EPS_MS
        });

        // 用户自己开的窗（判定层给出的重锚建议）落到账本上，下一轮即可按新锚点续窗。
        const effectiveLedger = decision.reanchorAtMs
          ? anchorWindowAt(reconciled, decision.reanchorAtMs, reconciled.windowMinutes, 'activity')
          : reconciled;
        const record = buildStateRecord(stored, effectiveLedger, decision, {
          now: currentNow,
          lastProbeAt,
          lastActivatedAt
        });
        // 跳过原因变化时打一行（稳态下不打，避免每 tick 刷屏）：这是「为什么没探」的
        // 事后取证入口。探测候选不在这里打 —— probeAccount 的成功/失败日志已含触发名。
        if (String(stored.lastDecisionReason || '') !== decision.trigger) {
          const detail = decision.trigger === 'runtime_blocked' && decision.runtimeReason
            ? `(${decision.runtimeReason})`
            : (view.closeAtMs > 0 ? `(close ${formatClock(view.closeAtMs)})` : '');
          logInfo(`window activation: ${accountRef} ${decision.action === 'probe' ? 'due' : 'skip'} ${decision.trigger}${detail}`);
        }
        // 探测候选的落盘交给 probeAccount（那里还要写探测结果），避免同一轮写两遍。
        if (decision.action !== 'probe' && !stateRecordsEqual(stored, record)) {
          persistAccountState(accountRef, record);
        }

        state.lastViews.set(accountRef, {
          provider,
          accountRef,
          view,
          observation: observation.kind,
          decision
        });
        decisions.push({
          provider,
          accountRef,
          action: decision.action,
          trigger: decision.trigger,
          window: {
            kind: view.kind,
            closeAtMs: view.closeAtMs,
            remainingMs: view.remainingMs,
            source: view.source
          }
        });
        if (decision.action === 'probe') {
          candidates.push({ account, decision, ledger: effectiveLedger, stored, lastActivatedAt });
        }
      }

      const batch = candidates.slice(0, config.batchSize);
      for (const item of batch) {
        try {
          probed.push(await probeAccount(item));
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
      state.lastResult = { at: currentNow, reason, probed, decisions };
      if (probed.length > 0) {
        const summary = probed.map((item) => `${item.accountRef}=${item.outcome}(${item.trigger})`).join(' ');
        logInfo(`window activation tick (${reason}): ${summary}`);
      }
      return { ok: true, probed, decisions };
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
      accounts: Array.from(state.lastViews.values()).map((item) => ({
        provider: item.provider,
        accountRef: item.accountRef,
        window: item.view.kind,
        windowCloseAtMs: item.view.closeAtMs,
        windowSource: item.view.source,
        action: item.decision.action,
        trigger: item.decision.trigger
      })),
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
  DEFAULT_BATCH_SIZE,
  decideActivation,
  findWindowEntry,
  observeWindow,
  reconcileLedger,
  describeWindowView,
  normalizeWindowActivationConfig,
  createWindowActivationScheduler
};
