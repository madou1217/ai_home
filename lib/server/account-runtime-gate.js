'use strict';

// 账号运行态的统一门禁 —— 所有「把一次上游观察变成账号状态」的入口都走这里。
//
// 三条臂，语义固定，调用方不得自己拼：
//   1. observeFailure      上游失败观察（推理请求 / 模型轻探测 / 用量探测）→ 统一分类 → 统一记账 → 统一发布事件
//   2. observeProbeSuccess 探测成功（模型目录 / 用量接口真的返回了数据）→ 只清「成功探测能推翻」的阻塞
//   3. forceRecover        人工强制恢复调度 → 账号级运行态整体归零
//
// 为什么必须统一（历史教训）：探测路径曾经自己写一套内存清理 + 自己调 accountStateService，
// 于是①探测失败根本不进异常记账（账号看着健康、却永远探测失败，用户只能手动排查）；
// ②探测成功又把限流冷却一起清掉（实测把 failCount=48 的账号每次刷新都扔回池子打上游）。
// 现在探测与推理共用同一个 classifier（upstream-failure-policy）、同一个 applier
// （account-runtime-state.applyAccountFailurePolicy + router.markProxyAccountFailure 的连续
// 失败阈值）、同一条持久化链路（ACCOUNT_RUNTIME_CHANGED → runtimeStateIndexListener →
// accountStateService）。任何新增的「异常/恢复」判定都必须落在这里，不允许旁路。

const { classifyUpstreamFailure } = require('./upstream-failure-policy');
const {
  applyAccountFailurePolicy,
  clearBlockingAccountRuntimeState,
  deriveAccountRuntimeStatus,
  normalizeAccountRuntime,
  pickPersistedAccountRuntimeState
} = require('./account-runtime-state');
const {
  buildAccountRuntimeChangedEvent,
  buildAccountRuntimeEventBaseState
} = require('./account-runtime-event-publisher');
const { ACCOUNT_RUNTIME_CHANGED } = require('./account-runtime-event-types');
const { isNonRecoverableAgyAuthInvalidBlock } = require('../account/agy-auth-recovery');

// 一次成功的「凭据可用的探测」能推翻哪些失败种类：它直接证明端点可达且凭据被接受。
// 刻意不含 rate_limited / overloaded（/models 常年 200，限流只在聊天路径出现，清掉等于
// 把被限流的账号反复扔回上游）、不含 quota_exhausted / billing_blocked / permission_denied
// （探测成功不证明额度或权限恢复，它们由用量快照或人工强制恢复处理）。
const PROBE_REFUTABLE_FAILURE_KINDS = Object.freeze(new Set([
  'auth_invalid',
  'timeout',
  'network_error',
  'service_unavailable',
  'upstream_server_error',
  'unknown_error',
  'token_refresh_unavailable'
]));

// 探测成功能用的证据（与 account/state-service 的 RUNTIME_CLEAR_EVIDENCE 同口径）。
const PROBE_SUCCESS_EVIDENCE = Object.freeze(new Set([
  'models_probe_success',
  'native_session_success',
  'agy_usage_probe_verified'
]));

// agy 的「未登录」是不可恢复标记，只有它自己的成功用量探测（或人工/重新登录）能推翻。
const NON_RECOVERABLE_PROBE_EVIDENCE = Object.freeze(new Set(['agy_usage_probe_verified']));

// 可被「成功探测」清掉的 typed 冷却字段；rateLimitUntil / overloadUntil 永不在内。
const PROBE_REFUTABLE_UNTIL_FIELDS = Object.freeze([
  'authInvalidUntil',
  'networkUntil',
  'serviceUnavailableUntil',
  'upstreamErrorUntil'
]);

function normalizeText(value) {
  return String(value == null ? '' : value).trim();
}

/** 从探测/请求异常里取上游状态码：优先 error.status，其次 HTTP_<code> 形态的 error.code。 */
function readFailureStatusCode(error, detail) {
  const explicit = Number(error && error.status);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const fromCode = normalizeText(error && error.code).match(/^HTTP_(\d{3})$/i);
  if (fromCode) return Number(fromCode[1]);
  const fromText = normalizeText(detail || (error && error.message)).match(/\bHTTP (\d{3})\b/);
  return fromText ? Number(fromText[1]) : 0;
}

/** 从探测/请求异常里取可分类的正文：error.body / error.upstreamBody，退回 message。 */
function readFailureBody(error, detail) {
  if (error && (error.body || error.upstreamBody)) return error.body || error.upstreamBody;
  return normalizeText(detail || (error && error.message));
}

function emitRuntimeEvent(hub, event) {
  if (!hub || typeof hub.emit !== 'function') return false;
  const results = hub.emit(ACCOUNT_RUNTIME_CHANGED, event);
  return results === true || (Array.isArray(results) && results[0] === true);
}

// 成功探测只清「成功探测能推翻」的部分：auth_invalid 与瞬时类冷却归零，
// 限流/过载/额度类原样保留（见文件头注释的实测教训）。
function clearProbeRefutableRuntimeState(account) {
  normalizeAccountRuntime(account);
  PROBE_REFUTABLE_UNTIL_FIELDS.forEach((field) => { account[field] = 0; });
  account.cooldownUntil = Math.max(
    Number(account.rateLimitUntil) || 0,
    Number(account.overloadUntil) || 0
  );
  account.consecutiveFailures = 0;
  account.lastError = '';
  account.lastFailureKind = '';
  account.lastFailureReason = '';
  account.lastFailureAt = 0;
  return account;
}

function isProbeRefutableRuntimeState(account, nowMs) {
  if (!account || typeof account !== 'object') return false;
  const kind = normalizeText(account.lastFailureKind);
  if (PROBE_REFUTABLE_FAILURE_KINDS.has(kind)) return true;
  return PROBE_REFUTABLE_UNTIL_FIELDS.some((field) => Number(account[field] || 0) > nowMs);
}

function createAccountRuntimeGate(deps = {}) {
  const hub = deps.hub || null;
  const accountStateService = deps.accountStateService || null;
  const markProxyAccountFailure = typeof deps.markProxyAccountFailure === 'function'
    ? deps.markProxyAccountFailure
    : null;
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();

  // 状态变化只发布事件；DB 持久化与池/缓存副作用交给 runtime event listener（与推理路径同一链路）。
  // provider 由调用方显式传入：池账号在生产环境带 provider，但事件/持久化不该依赖账号对象长什么样。
  function publishRuntimeState(account, provider, source, options = {}) {
    const normalizedProvider = normalizeText(provider).toLowerCase();
    const accountRef = normalizeText(account && account.accountRef);
    if (!normalizedProvider || !accountRef) return false;
    const baseState = buildAccountRuntimeEventBaseState(account);
    const event = {
      ...(buildAccountRuntimeChangedEvent(account, options.previousStatus || 'unknown', source) || {}),
      provider: normalizedProvider,
      accountRef,
      nextStatus: deriveAccountRuntimeStatus(account).status,
      reason: options.reason || normalizeText(account.lastFailureReason || account.lastError),
      source,
      runtimeState: pickPersistedAccountRuntimeState(account),
      baseState,
      ...(options.reloadPool ? { reloadPool: true } : {})
    };
    if (emitRuntimeEvent(hub, event)) return true;
    // 没有 hub（单测/降级装配）：直接走账号状态服务，保持同样的持久化语义。
    if (accountStateService && typeof accountStateService.recordRuntimeFailure === 'function') {
      return Boolean(accountStateService.recordRuntimeFailure(accountRef, provider, event.runtimeState, baseState));
    }
    return false;
  }

  /**
   * 上游失败观察 —— 推理请求、模型轻探测、用量探测共用。
   * 未显式给 policy 时按 provider/statusCode/body/error/detail 走统一分类器。
   */
  function observeFailure(input = {}) {
    const account = input.account;
    const provider = normalizeText(input.provider || (account && account.provider)).toLowerCase();
    if (!account || typeof account !== 'object' || !provider) return { policy: null, applied: false };
    const model = normalizeText(input.model);
    // 显式传入的 statusCode/body 优先（调用方已经拿到原始响应时不必再猜）；
    // 只拿到异常对象时才从 error.status / HTTP_<code> / 正文里还原。
    const statusCode = Number(input.statusCode) > 0
      ? Number(input.statusCode)
      : readFailureStatusCode(input.error, input.detail);
    const policy = input.policy || classifyUpstreamFailure({
      provider,
      account,
      model,
      statusCode,
      body: input.body === undefined || input.body === null ? readFailureBody(input.error, input.detail) : input.body,
      error: input.error,
      detail: input.detail,
      defaultCooldownMs: input.defaultCooldownMs,
      nowMs: input.nowMs
    });
    if (!policy || !policy.shouldMarkFailure) return { policy, applied: false };
    const previousStatus = deriveAccountRuntimeStatus(account).status;
    applyAccountFailurePolicy(account, policy, { model, markProxyAccountFailure });
    publishRuntimeState(account, provider, input.source || 'server.upstream.failure', { previousStatus });
    return { policy, applied: true, status: deriveAccountRuntimeStatus(account).status };
  }

  /** 探测成功 —— 只清成功探测能推翻的阻塞（限流/过载/额度类保留）。 */
  function observeProbeSuccess(input = {}) {
    const account = input.account;
    const provider = normalizeText(input.provider || (account && account.provider)).toLowerCase();
    if (!account || typeof account !== 'object' || !provider) return { cleared: false, reason: 'invalid_account' };
    const evidence = normalizeText(input.evidence) || 'models_probe_success';
    if (!PROBE_SUCCESS_EVIDENCE.has(evidence)) return { cleared: false, reason: 'unsupported_evidence' };
    const kind = normalizeText(account.lastFailureKind);
    if (!isProbeRefutableRuntimeState(account, now())) return { cleared: false, reason: 'not_refutable', kind };
    if (isNonRecoverableAgyAuthInvalidBlock(provider, deriveAccountRuntimeStatus(account))
      && !NON_RECOVERABLE_PROBE_EVIDENCE.has(evidence)) {
      return { cleared: false, reason: 'non_recoverable', kind };
    }
    clearProbeRefutableRuntimeState(account);
    publishRuntimeState(account, provider, input.source || 'server.probe.success', { reason: evidence });
    return { cleared: true, kind };
  }

  /** 人工强制恢复调度 —— 账号级运行态整体归零（含 routingBlock 与模型级冷却）。 */
  function forceRecover(input = {}) {
    const account = input.account;
    const provider = normalizeText(input.provider || (account && account.provider)).toLowerCase();
    if (!account || typeof account !== 'object' || !provider) return { recovered: false, reason: 'invalid_account' };
    normalizeAccountRuntime(account);
    clearBlockingAccountRuntimeState(account);
    account.routingBlock = null;
    account.modelCooldowns = {};
    account.modelFailureStreaks = {};
    account.lastSuccessAt = now();
    publishRuntimeState(account, provider, input.source || 'server.account.restore_scheduling', {
      reason: 'manual_admin_clear',
      reloadPool: true
    });
    return { recovered: true };
  }

  return {
    forceRecover,
    observeFailure,
    observeProbeSuccess
  };
}

// 每个 server state 一个门禁实例：hub 由 server 装配时挂到 state（accountRuntimeEventHub），
// 调用方只需带上自己的 deps（accountStateService 等）。
function getAccountRuntimeGate(state, deps = {}) {
  const target = state && typeof state === 'object' ? state : {};
  const existing = target.accountRuntimeGate;
  if (existing && typeof existing.observeFailure === 'function') return existing;
  const gate = createAccountRuntimeGate({
    hub: deps.hub || target.accountRuntimeEventHub || null,
    accountStateService: deps.accountStateService || target.accountStateService || null,
    markProxyAccountFailure: deps.markProxyAccountFailure
  });
  target.accountRuntimeGate = gate;
  return gate;
}

module.exports = {
  PROBE_REFUTABLE_FAILURE_KINDS,
  PROBE_SUCCESS_EVIDENCE,
  clearProbeRefutableRuntimeState,
  createAccountRuntimeGate,
  getAccountRuntimeGate,
  isProbeRefutableRuntimeState,
  readFailureStatusCode
};
