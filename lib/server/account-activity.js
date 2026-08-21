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

const DEFAULT_RATE_WINDOW_MS = 10_000;
const MAX_RATE_SAMPLES = 1000;
// 一个回合内可能长时间只有模型在思考而没有任何工具事件；TTL 取得比常见的
// 事件间隔宽松，真正结束时由 turn-completed 立即清零，不靠过期兜底。
const DEFAULT_SESSION_TURN_TTL_MS = 120_000;

function createAccountActivity(options = {}) {
  const windowMs = Math.max(1000, Number(options.windowMs) || DEFAULT_RATE_WINDOW_MS);
  const sessionTurnTtlMs = Math.max(
    1000,
    Number(options.sessionTurnTtlMs) || DEFAULT_SESSION_TURN_TTL_MS
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
        sessionTurnUntil: 0
      };
      states.set(key, state);
    }
    return state;
  }

  function normalizeModel(model) {
    return String(model || '').trim();
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

  // 全量快照：activeModels 只包含当前仍有 in-flight attempt 的模型。
  // 只输出有活动的账号；rate 为最近 windowMs 内发起的请求次数。
  function snapshot() {
    const result = {};
    const snapshotAt = now();
    for (const [key, state] of states) {
      prune(state);
      const sessionTurnActive = state.sessionTurnUntil > snapshotAt;
      if (!sessionTurnActive) state.sessionTurnUntil = 0;
      if (
        state.inFlight <= 0
        && !sessionTurnActive
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
        // 会话回合折算成一个 in-flight：对 UI 而言「这个账号此刻在服务」是同一件事。
        inFlight: state.inFlight + (sessionTurnActive ? 1 : 0),
        sessionTurnActive,
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
    snapshot,
    // 测试/诊断用
    _states: states
  };
}

module.exports = {
  createAccountActivity,
  DEFAULT_RATE_WINDOW_MS,
  DEFAULT_SESSION_TURN_TTL_MS
};
