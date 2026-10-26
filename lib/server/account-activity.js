'use strict';

// per-(provider, accountRef) 实时活动计数，并保留当前 in-flight 的模型集合。
//
// 回答一个问题：「哪个账号此刻正在提供服务，服务得多猛」。
// 无论请求来自 CLI 会话、WebUI 还是 API Key 直连，只要经过网关执行 attempt，
// 就计入对应账号的 in-flight；最近 10s 的请求开始次数作为速率（rate）。
// WebUI / CLI 用它驱动「账号运行中」指示与转圈速度。
//
// 挂点：lib/server/request-orchestrator.js 的 onAttempt 调用处（所有走账号尝试
// 编排的 provider 共用），begin 于 attempt 进入时、end 于 attempt 结束（finally），
// 天然配对，重试/换号/同号延迟重试都正确。
//
// 第二条通道：原生 CLI 会话（`aih claude 9`、WebUI 原生会话）直连上游，不经过
// 网关 attempt 编排，网关对它们的 in-flight 一无所知。这类会话由 provider 官方
// hook 上报回合事件（见 provider-hook-account-activity.js）。hook 投递天然有损
// ——进程可能被杀、发送有超时——所以会话回合用「最后一次回合事件 + TTL」表达，
// 而不是 begin/end 计数：漏掉一个 Stop 只会让状态自然过期，不会永久泄漏成
// 「图标一直转圈」。

const { ACCOUNT_SELECTION_RATE_WINDOW_MS } = require('../cli/config/constants');
const DEFAULT_RATE_WINDOW_MS = ACCOUNT_SELECTION_RATE_WINDOW_MS;
const MAX_RATE_SAMPLES = 1000;
// 一个回合内可能长时间只有模型在思考而没有任何工具事件；TTL 取得比常见的
// 事件间隔宽松，真正结束时由 turn-completed 立即清零，不靠过期兜底。
const DEFAULT_SESSION_TURN_TTL_MS = 120_000;
// 第三条来源（aih 托管的持久 CLI 会话）由轮询驱动：TTL 取两个轮询周期以上，
// 一次探测失败（tmux 忙 / 超时）不会立刻熄灯，被杀掉的会话会在两轮内过期。
const DEFAULT_SESSION_RUNTIME_TTL_MS = 15_000;

function createAccountActivity(options = {}) {
  const windowMs = Math.max(1000, Number(options.windowMs) || DEFAULT_RATE_WINDOW_MS);
  const sessionTurnTtlMs = Math.max(
    1000,
    Number(options.sessionTurnTtlMs) || DEFAULT_SESSION_TURN_TTL_MS
  );
  const sessionRuntimeTtlMs = Math.max(
    1000,
    Number(options.sessionRuntimeTtlMs) || DEFAULT_SESSION_RUNTIME_TTL_MS
  );
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const states = new Map();

  function keyOf(provider, accountRef) {
    const text = String(accountRef || '').trim();
    if (!text) return null;
    return `${String(provider || '').trim().toLowerCase()}:${text}`;
  }

  function getState(key) {
    let state = states.get(key);
    if (!state) {
      state = {
        inFlight: 0,
        modelInFlight: new Map(),
        samples: [],
        lastActivityAt: 0,
        sessionTurnUntil: 0,
        runtimeUntil: 0,
        runtimeSessions: 0,
        runtimeAttached: 0
      };
      states.set(key, state);
    }
    return state;
  }

  function normalizeModel(model) {
    return String(model || '').trim().toLowerCase();
  }

  function prune(state) {
    const cutoff = now() - windowMs;
    while (state.samples.length > 0 && state.samples[0] < cutoff) state.samples.shift();
  }

  // 请求 attempt 进入：in-flight +1，记一次速率采样。
  function begin(provider, accountRef, model) {
    const key = keyOf(provider, accountRef);
    if (!key) return;
    const state = getState(key);
    state.inFlight += 1;
    const activeModel = normalizeModel(model);
    if (activeModel) {
      state.modelInFlight.set(
        activeModel,
        Number(state.modelInFlight.get(activeModel) || 0) + 1
      );
    }
    state.lastActivityAt = now();
    state.samples.push(state.lastActivityAt);
    if (state.samples.length > MAX_RATE_SAMPLES) state.samples.shift();
  }

  // 请求 attempt 结束：in-flight -1（下限 0）。
  function end(provider, accountRef, model) {
    const key = keyOf(provider, accountRef);
    if (!key) return;
    const state = states.get(key);
    if (!state) return;
    state.inFlight = Math.max(0, state.inFlight - 1);
    const activeModel = normalizeModel(model);
    if (activeModel) {
      const remaining = Math.max(0, Number(state.modelInFlight.get(activeModel) || 0) - 1);
      if (remaining > 0) state.modelInFlight.set(activeModel, remaining);
      else state.modelInFlight.delete(activeModel);
    }
    // 防御不成对的旧调用：账号已无任何请求时，模型集合也必须归零，避免 UI 假燃烧。
    if (state.inFlight === 0) state.modelInFlight.clear();
    state.lastActivityAt = now();
  }

  // 原生会话回合开始/继续：刷新该账号的会话活跃期限。
  // 任何 turn-* 事件都算「还在跑」，包括工具调用这类回合内事件。
  function markSessionTurn(provider, accountRef, options = {}) {
    const key = keyOf(provider, accountRef);
    if (!key) return;
    const ttlMs = Math.max(1000, Number(options.ttlMs) || sessionTurnTtlMs);
    const state = getState(key);
    const at = now();
    state.sessionTurnUntil = at + ttlMs;
    state.lastActivityAt = at;
  }

  // 原生会话回合结束：立即熄灯，不等 TTL 过期。
  function endSessionTurn(provider, accountRef) {
    const key = keyOf(provider, accountRef);
    if (!key) return;
    const state = states.get(key);
    if (!state) return;
    state.sessionTurnUntil = 0;
    state.lastActivityAt = now();
  }

  // 第三条来源：aih 托管的持久 CLI 会话（`aih <provider> <id>`）是否存在且存活。
  //
  // 为什么需要它：begin/end 只覆盖经过网关的请求，markSessionTurn 只覆盖合同声明
  // sessionSync.mode='hook' 的 provider（codex/claude/gemini/agy/opencode/grok）。
  // 其余 provider（kimi/zcode/codebuddy 家族/cline/qoder/kiro）的 CLI 会话在网关和
  // hook 两侧都没有信号，账号的 in-use 状态捕获不到。持久会话注册表对**所有**
  // provider 都成立，所以由轮询按 (provider, accountRef) 打这个标记。
  //
  // 与 hook 回合一样用「标记 + TTL」而不是计数：轮询进程被杀或 tmux 暂时不可用时
  // 只会自然过期，不会永久泄漏成「一直在转圈」。
  function markRuntime(provider, accountRef, options = {}) {
    const key = keyOf(provider, accountRef);
    if (!key) return;
    const ttlMs = Math.max(1000, Number(options.ttlMs) || sessionRuntimeTtlMs);
    const state = getState(key);
    const at = now();
    state.runtimeUntil = at + ttlMs;
    state.runtimeSessions = Math.max(0, Number(options.sessions) || 0);
    state.runtimeAttached = Math.max(0, Number(options.attached) || 0);
    state.lastActivityAt = at;
  }

  // 全量快照：activeModels 只包含当前仍有 in-flight attempt 的模型。
  // 只输出有活动的账号；rate 为最近 windowMs 内发起的请求次数。
  function snapshot() {
    const result = {};
    const snapshotAt = now();
    for (const [key, state] of states) {
      prune(state);
      const sessionTurnActive = state.sessionTurnUntil > snapshotAt;
      if (!sessionTurnActive) state.sessionTurnUntil = 0;
      const runtimeActive = state.runtimeUntil > snapshotAt;
      if (!runtimeActive) {
        state.runtimeUntil = 0;
        state.runtimeSessions = 0;
        state.runtimeAttached = 0;
      }
      // 只有「用户正在其中」的持久会话（attached）才折算成服务中；detached 的
      // 存活会话（重启恢复、后台监督 pane）仍然上报，但不点亮转圈。
      const runtimeServing = runtimeActive && state.runtimeAttached > 0;
      if (
        state.inFlight <= 0
        && !sessionTurnActive
        && !runtimeActive
        && state.samples.length <= 0
        && state.lastActivityAt <= 0
      ) {
        states.delete(key);
        continue;
      }
      const sep = key.indexOf(':');
      result[key] = {
        provider: key.slice(0, sep),
        accountRef: key.slice(sep + 1),
        // 会话回合 / 持久 CLI 会话各折算成一个 in-flight：对 UI 而言「这个账号此刻在服务」是同一件事。
        inFlight: state.inFlight + (sessionTurnActive ? 1 : 0) + (runtimeServing ? 1 : 0),
        sessionTurnActive,
        // aih 托管的持久 CLI 会话：runtimeActive = 有存活会话，runtimeAttached = 用户正在其中。
        runtimeActive,
        runtimeSessions: state.runtimeSessions,
        runtimeAttached: state.runtimeAttached,
        rate: state.samples.length,
        activeModels: Array.from(state.modelInFlight.entries())
          .filter(([, count]) => count > 0)
          .map(([model]) => model)
          .sort(),
        lastActivityAt: state.lastActivityAt,
        updatedAt: snapshotAt
      };
    }
    return result;
  }

  return {
    begin,
    end,
    markSessionTurn,
    endSessionTurn,
    markRuntime,
    snapshot,
    // Scheduling uses actual gateway attempts, not the UI's attached-session
    // approximation. Reading one account does not allocate state or scan the pool.
    selectionLoad(provider, accountRef, model) {
      const state = states.get(keyOf(provider, accountRef));
      if (!state) return { inFlight: 0, modelInFlight: 0, rate: 0, windowMs };
      prune(state);
      return {
        inFlight: state.inFlight, modelInFlight: state.modelInFlight.get(normalizeModel(model)) || 0,
        rate: state.samples.length, windowMs
      };
    },
    // 测试/诊断用
    _states: states
  };
}

module.exports = {
  createAccountActivity,
  DEFAULT_RATE_WINDOW_MS,
  DEFAULT_SESSION_TURN_TTL_MS,
  DEFAULT_SESSION_RUNTIME_TTL_MS
};
