'use strict';

// **账号并发/频率阀门**（所有 relay 共用；**默认关闭**）。
//
// 为什么要有抽象层：上游对「同一账号同时/连续发多少请求」的态度各不相同，且都与
// provider 语义无关，是**账号级运行约束**：
//   * 按 (账号, 模型) 限制在飞数 —— 真机 zcode 回 429 `code:3008/3009`
//     "model concurrency limit exceeded"（桌面端也撞到，它靠换模型绕开）；
//   * 对短时间内的重复请求直接风控 —— 真机 zcode 回 405 `code:3012`
//     "request has been blocked due to unusual activity."，连打会升级到全模型。
// 因此形状由描述符声明（`relay.pacing`），状态机与派发在本模块：
// **新增一种节流策略 = 加一个策略实现 + 一个 kind**，派发代码零改动；不写 provider 名分支。
//
// 声明形状（lib/providers/contract.js 白名单化，写错立刻被拒）：
//   {
//     kind: 'account-window',                 // 策略键（当前唯一实现）
//     scope: 'account' | 'account-model',     // 状态键粒度（缺省 account）
//     maxInFlight?: number,                   // 同一 key 在飞的上游请求数上限（0/缺省 = 不限）
//     minIntervalMs?: number,                 // 同一 key 两次请求**开始**之间的最小间隔
//     onLimit?: 'queue' | 'reject',           // 超限行为（缺省 queue）
//     maxWaitMs?: number                      // 排队上限（缺省 30000）；超过后放行并标记 timedOut
//   }
// 语义要点：
//   * 在飞计数**覆盖整个上游响应生命周期**（含 SSE 流到结束）—— 调用方在流结束/失败后才
//     release（见 upstream-endpoints-transport-chain 的 try/finally）；
//   * `onLimit: 'queue'`（默认）超时后**放行**而不是报错：让请求冒一点风险，好过给客户端
//     一个 5xx（上游本来也只是「还没轮到」）；
//   * `onLimit: 'reject'` 立即返回 null，调用方按「本次尝试未执行」处理（可换号重试）。

// 白名单来自**契约**（声明的事实源；校验在 lib/providers/contract.js，这里只消费），
// 避免两处各维护一份同义名单。
const {
  RELAY_PACING_KINDS: PACING_KINDS,
  RELAY_PACING_ON_LIMIT: PACING_ON_LIMIT,
  RELAY_PACING_SCOPES: PACING_SCOPES
} = require('../providers/contract');
const DEFAULT_MAX_WAIT_MS = 30000;

const stateByKey = new Map();

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeCount(value) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? Math.floor(num) : 0;
}

/**
 * 规范化一份 pacing 声明（非法/空 → null = 不限流）。
 * 与契约校验同源：契约已白名单化，这里只做「缺失即关闭」的兜底。
 */
function normalizePacingDeclaration(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const kind = normalizeText(raw.kind);
  if (!PACING_KINDS.includes(kind)) return null;
  const maxInFlight = normalizeCount(raw.maxInFlight);
  const minIntervalMs = normalizeCount(raw.minIntervalMs);
  if (!maxInFlight && !minIntervalMs) return null;
  const scope = PACING_SCOPES.includes(normalizeText(raw.scope)) ? normalizeText(raw.scope) : 'account';
  const onLimit = PACING_ON_LIMIT.includes(normalizeText(raw.onLimit)) ? normalizeText(raw.onLimit) : 'queue';
  const maxWaitMs = normalizeCount(raw.maxWaitMs) || DEFAULT_MAX_WAIT_MS;
  return { kind, scope, maxInFlight, minIntervalMs, onLimit, maxWaitMs };
}

/**
 * 读描述符声明的 pacing（唯一入口：消费方问能力，不认 provider 名）。
 */
function relayPacingDeclaration(provider) {
  try {
    const { getProviderCapability } = require('../providers');
    const relay = getProviderCapability(provider, 'relay');
    return normalizePacingDeclaration(relay && relay.pacing);
  } catch (_error) {
    return null;
  }
}

function resolvePacingKey(declaration, input) {
  const provider = normalizeText(input.provider);
  const accountRef = normalizeText(input.accountRef);
  if (!provider || !accountRef) return '';
  const model = declaration.scope === 'account-model' ? normalizeText(input.model) : '';
  return model ? `${provider}|${accountRef}|${model}` : `${provider}|${accountRef}`;
}

function readPacingState(key) {
  let state = stateByKey.get(key);
  if (!state) {
    state = {
      inFlight: 0,
      lastStartAt: 0,
      waiters: [],
      stats: { granted: 0, waitedMs: 0, timedOut: 0, rejected: 0 }
    };
    stateByKey.set(key, state);
  }
  return state;
}

function makeGrant(state, declaration, waitedMs, timedOut) {
  let released = false;
  return {
    gated: true,
    waitedMs,
    timedOut,
    release() {
      if (released) return;
      released = true;
      state.inFlight = Math.max(0, state.inFlight - 1);
      drainPacingQueue(state, declaration);
    }
  };
}

function drainPacingQueue(state, declaration) {
  while (state.waiters.length > 0) {
    const head = state.waiters[0];
    const now = Date.now();
    const inFlightOk = declaration.maxInFlight <= 0 || state.inFlight < declaration.maxInFlight;
    const intervalOk = declaration.minIntervalMs <= 0 || (now - state.lastStartAt) >= declaration.minIntervalMs;
    if (now >= head.deadline || (inFlightOk && intervalOk)) {
      state.waiters.shift();
      if (head.timer) {
        clearTimeout(head.timer);
        head.timer = null;
      }
      const timedOut = now >= head.deadline;
      state.inFlight += 1;
      state.lastStartAt = now;
      state.stats.granted += 1;
      state.stats.waitedMs += now - head.startedAt;
      if (timedOut) state.stats.timedOut += 1;
      head.resolve(makeGrant(state, declaration, now - head.startedAt, timedOut));
      continue;
    }
    if (!head.timer) {
      const delay = intervalOk
        ? 25
        : Math.max(5, declaration.minIntervalMs - (now - state.lastStartAt));
      head.timer = setTimeout(() => {
        head.timer = null;
        drainPacingQueue(state, declaration);
      }, delay);
      if (head.timer && typeof head.timer.unref === 'function') head.timer.unref();
    }
    return;
  }
}

const NO_GATE = Object.freeze({
  gated: false,
  waitedMs: 0,
  timedOut: false,
  release() {}
});

/**
 * 取一个账号槽位。
 *
 * @param {object} input { provider, accountRef, model, pacing|declaration }
 * @returns {Promise<{gated: boolean, waitedMs: number, timedOut: boolean, release: Function}|null>}
 *   null = `onLimit: 'reject'` 且当前超限（调用方按「本次尝试未执行」处理）。
 */
function acquireAccountPacing(input = {}) {
  const declaration = normalizePacingDeclaration(
    input.declaration === undefined ? input.pacing : input.declaration
  );
  if (!declaration) return Promise.resolve(NO_GATE);
  const key = resolvePacingKey(declaration, input);
  if (!key) return Promise.resolve(NO_GATE);
  const state = readPacingState(key);
  const startedAt = Date.now();
  const inFlightOk = declaration.maxInFlight <= 0 || state.inFlight < declaration.maxInFlight;
  const intervalOk = declaration.minIntervalMs <= 0
    || (startedAt - state.lastStartAt) >= declaration.minIntervalMs;
  if (inFlightOk && intervalOk) {
    state.inFlight += 1;
    state.lastStartAt = startedAt;
    state.stats.granted += 1;
    return Promise.resolve(makeGrant(state, declaration, 0, false));
  }
  if (declaration.onLimit === 'reject') {
    state.stats.rejected += 1;
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    state.waiters.push({
      resolve,
      timer: null,
      startedAt,
      deadline: startedAt + declaration.maxWaitMs
    });
    drainPacingQueue(state, declaration);
  });
}

/** 诊断/测试用：当前各 key 的在飞数、排队数与计数。 */
function getAccountPacingStats() {
  const out = {};
  for (const [key, state] of stateByKey.entries()) {
    out[key] = { inFlight: state.inFlight, queued: state.waiters.length, ...state.stats };
  }
  return out;
}

module.exports = {
  PACING_KINDS,
  PACING_ON_LIMIT,
  PACING_SCOPES,
  acquireAccountPacing,
  getAccountPacingStats,
  normalizePacingDeclaration,
  relayPacingDeclaration
};
