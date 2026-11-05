'use strict';

const { normalizeAccountStatusValue } = require('./status-file');
const {
  clearBlockingAccountRuntimeState,
  clearExpiredAccountModelState,
  deriveAccountRuntimeStatus,
  isRoutingBlockActive
} = require('../server/account-runtime-state');
const {
  isNonRecoverableAgyAuthInvalidBlock
} = require('./agy-auth-recovery');
const { sanitizeBaseState } = require('./state-sync-policy');
const { recoverQuotaRuntimeState, trustedCodexSnapshot } = require('./quota-runtime-recovery');
const { publishAccountLifecycleEvent } = require('../server/account-lifecycle-bus');
const statusEventJournal = require('../server/status-event-journal');

const RUNTIME_CLEAR_EVIDENCE = new Set([
  'direct_usage_success',
  'direct_rate_limit_success',
  'agy_oauth_credentials_recoverable',
  'api_key_config_verified',
  'credential_config_verified',
  'credential_update_after_failure',
  'login_success',
  'manual_admin_clear',
  'models_probe_success',
  'native_session_success',
  // 「本地 access token 仍然有效」（刷新被拒但 token 未过期）：只推翻 auth_invalid，
  // 不动并发限流/网络冷却（见下面的分支）。此前该证据未登记，codex reconciler 那条路径
  // 在生产上是静默 no-op，只有单测的 stub 才"清"得掉。
  'access_token_still_valid',
  'token_refresh_success',
  'upstream_success',
  'verified_usage_success',
  // agy 成功用量探测：直接证明账号可用，可清 auth_invalid（含推翻 agy_not_signed_in 误判）。
  'agy_usage_probe_verified'
]);
const NON_RECOVERABLE_RUNTIME_CLEAR_EVIDENCE = new Set([
  'login_success',
  'manual_admin_clear',
  // 成功探测是"已登录"的直接证据，足以覆盖 agy_not_signed_in 这类不可恢复标记。
  'agy_usage_probe_verified'
]);
// 到期待复核的路由阻塞只由「真实流量成功」解除：账单 / 权限 / 额度能不能用，只有真的用一次
// 才知道（探测、刷新 token、读用量都证明不了）。其它证据只清它们自己能证明的部分并保留这个
// 阻塞 —— 选号器借它只放行一个试探请求，不让一批请求同时打到可能仍受限的账号。
const ROUTING_BLOCK_RECHECK_SUCCESS_EVIDENCE = new Set([
  'upstream_success',
  'native_session_success'
]);

function normalizeProvider(provider) {
  return String(provider || '').trim().toLowerCase();
}

// 状态服务是运行态写入的唯一漏斗，所以事件日志也挂在这里：
//   - clearRuntimeBlock 的 evidence 决定「哪些阻塞该解除」，Go oracle 必须看到它；
//   - recordRuntimeState 是整份替换（含 null 显式清空），它定义 oracle 的输入快照。
// 未启用时 isEnabled() 直接短路；append 本身也不会抛，但这里仍然兜一层 —— 观测能力
// 坏了不能让一次清除/写入失败。
function recordStatusEvent(event) {
  if (!statusEventJournal.isEnabled()) return;
  try {
    statusEventJournal.append(event);
  } catch (_error) {
    // best-effort：观测不是主流程。
  }
}

function normalizeAccountRef(accountRef) {
  const ref = String(accountRef || '').trim();
  return /^acct_[a-f0-9]{20}$/.test(ref) ? ref : '';
}

function normalizeDisplayName(value) {
  return String(value || '').trim();
}

function readRowValue(row, key) {
  if (!row || typeof row !== 'object') return undefined;
  return Object.prototype.hasOwnProperty.call(row, key) ? row[key] : undefined;
}

function readRowBoolean(row, key) {
  const value = readRowValue(row, key);
  if (typeof value === 'boolean') return value;
  if (value == null) return false;
  return Number(value) === 1;
}

function readRowString(row, key) {
  const value = readRowValue(row, key);
  return String(value || '').trim();
}

function readRowNumber(row, key) {
  const value = readRowValue(row, key);
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function normalizeBaseState(row, overrides = {}) {
  const status = normalizeAccountStatusValue(
    overrides.status != null ? overrides.status : readRowString(row, 'status')
  ) || 'up';
  const configured = typeof overrides.configured === 'boolean'
    ? overrides.configured
    : readRowBoolean(row, 'configured');
  const apiKeyMode = typeof overrides.apiKeyMode === 'boolean'
    ? overrides.apiKeyMode
    : readRowBoolean(row, 'apiKeyMode');
  const authMode = overrides.authMode != null
    ? String(overrides.authMode || '').trim()
    : readRowString(row, 'authMode');
  const displayName = overrides.displayName != null
    ? normalizeDisplayName(overrides.displayName)
    : readRowString(row, 'displayName');
  const remainingPct = overrides.remainingPct !== undefined
    ? overrides.remainingPct
    : readRowNumber(row, 'remainingPct');

  const baseState = {
    status,
    configured,
    apiKeyMode,
    authMode,
    displayName
  };
  if (remainingPct != null && Number.isFinite(Number(remainingPct))) {
    baseState.remainingPct = Number(remainingPct);
  }
  return baseState;
}

function normalizeSynchronizedBaseState(row, overrides = {}) {
  return sanitizeBaseState(normalizeBaseState(row, overrides));
}

function clearAccountWideRuntimeState(runtimeState) {
  if (!runtimeState || typeof runtimeState !== 'object') return null;
  const next = clearExpiredAccountModelState(clearBlockingAccountRuntimeState({ ...runtimeState }));
  const hasModelCooldowns = next.modelCooldowns && Object.keys(next.modelCooldowns).length > 0;
  const hasModelFailureStreaks = next.modelFailureStreaks
    && Object.keys(next.modelFailureStreaks).length > 0;
  return next.routingBlock || hasModelCooldowns || hasModelFailureStreaks ? next : null;
}

function canClearRuntimeBlock(provider, runtimeState, evidence) {
  if (!isNonRecoverableAgyAuthInvalidBlock(provider, deriveAccountRuntimeStatus(runtimeState))) return true;
  return NON_RECOVERABLE_RUNTIME_CLEAR_EVIDENCE.has(evidence);
}

// agy 地区资格块：native 会话把 "Eligibility check failed … not available in your location"
// 记成 routingBlock(permission_denied / agy_region_not_eligible)。agy 的用量探测打的就是做资格
// 判定的 code-assist 端点（loadCodeAssist / fetchAvailableModels），所以「探测成功且不早于该失败」
// 是「当前地区已可用」的直接证据，可推翻这个路由阻塞（用户改区后刷新即恢复，无需人工"恢复调度"）。
// 只针对这一个块：其它 routingBlock（quota_exhausted 仍走 codex 的额度快照恢复；billing_blocked
// 与非地区类 permission_denied 到复核时刻后由真实流量试探解除）与其它 provider 都不受本分支影响。
const AGY_REGION_BLOCK_REASON = 'agy_region_not_eligible';
const AGY_REGION_BLOCK_CLEAR_EVIDENCE = new Set([
  'verified_usage_success',
  'agy_usage_probe_verified'
]);

function isAgyRegionBlock(provider, runtimeState) {
  if (normalizeProvider(provider) !== 'agy') return false;
  const block = runtimeState && runtimeState.routingBlock;
  return Boolean(
    block
    && block.kind === 'permission_denied'
    && String(block.reason || '').includes(AGY_REGION_BLOCK_REASON)
  );
}

function hasProbeEvidenceNewerThanFailure(usageSnapshot, runtimeState) {
  const capturedAt = Number(usageSnapshot && usageSnapshot.capturedAt);
  if (!Number.isFinite(capturedAt) || capturedAt <= 0) return false;
  return capturedAt >= (Number(runtimeState && runtimeState.lastFailureAt) || 0);
}

function createAccountStateService(options = {}) {
  const { stateIndexClient } = options;

  function getIndex() {
    if (options.accountStateIndex) return options.accountStateIndex;
    if (typeof options.getAccountStateIndex !== 'function') return null;
    try {
      return options.getAccountStateIndex();
    } catch (_error) {
      return null;
    }
  }

  function getAccountState(accountRef) {
    const index = getIndex();
    const ref = normalizeAccountRef(accountRef);
    if (!index || typeof index.getAccountState !== 'function' || !ref) return null;
    return index.getAccountState(ref) || null;
  }

  function syncAccountBaseState(accountRef, provider, state = {}) {
    const index = getIndex();
    const ref = normalizeAccountRef(accountRef);
    const p = normalizeProvider(provider);
    if (!ref || !p) return false;
    const baseState = sanitizeBaseState(state);
    let updated = false;
    if (index && typeof index.upsertAccountState === 'function') {
      updated = index.upsertAccountState(ref, p, baseState);
    }
    if (stateIndexClient && typeof stateIndexClient.upsert === 'function') {
      stateIndexClient.upsert(ref, p, baseState);
      updated = true;
    }
    return updated;
  }

  function setOperationalStatus(accountRef, provider, status, baseState = {}, eventOptions = {}) {
    const index = getIndex();
    const ref = normalizeAccountRef(accountRef);
    const p = normalizeProvider(provider);
    const normalizedStatus = normalizeAccountStatusValue(status);
    if (!ref || !p || !normalizedStatus) return false;

    const current = getAccountState(ref) || {};
    let updated = false;
    if (index && current.accountRef && typeof index.setStatus === 'function') {
      updated = index.setStatus(ref, normalizedStatus);
    }
    const nextState = normalizeBaseState(current, {
      ...baseState,
      status: normalizedStatus
    });
    if (!updated && index && typeof index.upsertAccountState === 'function') {
      updated = index.upsertAccountState(ref, p, nextState);
    }
    if (stateIndexClient && typeof stateIndexClient.setOperationalStatus === 'function') {
      stateIndexClient.setOperationalStatus(
        ref,
        p,
        normalizedStatus,
        sanitizeBaseState(nextState)
      );
      updated = true;
    }
    if (!updated) return false;
    // 只有调用方明确声明「这是一次用户可见的启停」时才发布生命周期事件。
    // 认证失效后的自动下线走 ACCOUNT_RUNTIME_CHANGED，不能被伪装成用户关闭。
    if (eventOptions && eventOptions.lifecycle === true) {
      publishAccountLifecycleEvent(normalizedStatus === 'down' ? 'disabled' : 'enabled', {
        provider: p,
        accountRef: ref,
        source: String(eventOptions.source || 'state-service').trim(),
        reason: String(eventOptions.reason || '').trim(),
        before: { status: String(current.status || '').trim() },
        after: { status: normalizedStatus, enabled: normalizedStatus !== 'down' }
      });
    }
    return true;
  }

  function recordRuntimeFailure(accountRef, provider, runtimeState, baseState = {}) {
    const index = getIndex();
    const ref = normalizeAccountRef(accountRef);
    const p = normalizeProvider(provider);
    if (!index || typeof index.upsertRuntimeState !== 'function' || !ref || !p) return false;
    const current = getAccountState(ref) || {};
    const nextBaseState = normalizeSynchronizedBaseState(current, baseState);
    // CLI 进程不直接写库：交给服务端统一落库并推送 Go（见 management-router）。
    if (stateIndexClient && typeof stateIndexClient.upsertRuntimeState === 'function') {
      stateIndexClient.upsertRuntimeState(ref, p, runtimeState, nextBaseState);
      return true;
    }
    return index.upsertRuntimeState(ref, p, runtimeState, nextBaseState);
  }

  function clearRuntimeBlock(accountRef, provider, options = {}) {
    const evidence = String(options.evidence || '').trim();
    if (!RUNTIME_CLEAR_EVIDENCE.has(evidence)) return false;
    // 入口处记录（白名单外的 evidence 本来就清不动任何东西，不写）：双读比对要验证的
    // 正是「同一串证据，Node 和 Go 是否解除同一个阻塞」，少记一条都会让差异无法归因。
    recordStatusEvent({
      accountRef: normalizeAccountRef(accountRef),
      provider: normalizeProvider(provider),
      op: 'clear',
      atMs: Date.now(),
      evidence
    });
    const index = getIndex();
    const ref = normalizeAccountRef(accountRef);
    const p = normalizeProvider(provider);
    if (!index || typeof index.upsertRuntimeState !== 'function' || !ref || !p) return false;
    const current = getAccountState(ref) || {};
    const currentRuntimeState = current.runtimeState;
    const baseState = options.baseState && typeof options.baseState === 'object'
      ? options.baseState
      : options;
    const nextBaseState = normalizeSynchronizedBaseState(current, baseState);
    // 所有运行态写入都经这里：CLI 走服务端，服务端走 index（更新内存并异步推送 Go）。
    const persist = (next, base = nextBaseState) => {
      if (stateIndexClient && typeof stateIndexClient.upsertRuntimeState === 'function') {
        stateIndexClient.upsertRuntimeState(ref, p, next, base);
        return true;
      }
      return index.upsertRuntimeState(ref, p, next, base);
    };
    if (!currentRuntimeState) {
      if (typeof index.upsertAccountState === 'function') {
        const stored = index.upsertAccountState(ref, p, nextBaseState);
        // 本地没有运行态时，Go 可能还留着上一轮的文档：显式清除。
        if (stored) {
          if (stateIndexClient && typeof stateIndexClient.clearRuntimeState === 'function') {
            stateIndexClient.clearRuntimeState(ref, p, nextBaseState);
          } else if (typeof index.clearRuntimeState === 'function') {
            index.clearRuntimeState(ref);
          }
        }
        return stored;
      }
      return false;
    }
    if (!canClearRuntimeBlock(p, currentRuntimeState, evidence)) return false;
    if (p === 'codex' && evidence === 'verified_usage_success' && options.usageSnapshot) {
      let next = recoverQuotaRuntimeState(p, currentRuntimeState, options.usageSnapshot);
      // 真额度接口成功也能证明凭据有效；其它运行态仍保留。
      if (trustedCodexSnapshot(options.usageSnapshot)
        && Number(options.usageSnapshot.capturedAt) > Number(currentRuntimeState.lastFailureAt)
        && deriveAccountRuntimeStatus(currentRuntimeState).status === 'auth_invalid') {
        next = { ...next, authInvalidUntil: 0 };
        next.cooldownUntil = Math.max(0, ...['rateLimitUntil', 'overloadUntil', 'networkUntil', 'serviceUnavailableUntil', 'upstreamErrorUntil']
          .map(key => Number(next[key]) || 0));
      }
      return next !== currentRuntimeState ? persist(next) : false;
    }
    // agy 地区资格块可被成功的用量探测推翻（见 isAgyRegionBlock 注释），不落进下面的
    // routingBlock 硬闸门；CLI 刷新（verified_usage_success）与池重建收敛（agy_usage_probe_verified）
    // 共用同一谓词，两条路径的判定不会分叉。
    if (AGY_REGION_BLOCK_CLEAR_EVIDENCE.has(evidence)
      && isAgyRegionBlock(p, currentRuntimeState)
      && hasProbeEvidenceNewerThanFailure(options.usageSnapshot, currentRuntimeState)) {
      return persist(clearAccountWideRuntimeState({ ...currentRuntimeState, routingBlock: null }));
    }
    // 未到复核时刻的路由阻塞只认人工清除；到期待复核的阻塞不再挡住其它恢复证据（例如凭据刷新
    // 成功后解除 auth_invalid），阻塞本身按 ROUTING_BLOCK_RECHECK_SUCCESS_EVIDENCE 决定去留。
    if (isRoutingBlockActive(currentRuntimeState.routingBlock, Date.now())
      && evidence !== 'manual_admin_clear') return false;
    if (evidence === 'manual_admin_clear' && options.scope === 'routing_block') {
      const block = currentRuntimeState.routingBlock;
      if (!block) return false;
      const next = { ...currentRuntimeState, routingBlock: null };
      if (next.lastFailureKind === block.kind) {
        next.lastFailureKind = '';
        next.lastFailureReason = '';
        next.lastError = '';
        next.lastFailureAt = 0;
        next.consecutiveFailures = 0;
        next.cooldownUntil = Math.max(0, ...['authInvalidUntil', 'rateLimitUntil', 'overloadUntil', 'networkUntil', 'serviceUnavailableUntil', 'upstreamErrorUntil']
          .map(key => Number(next[key]) || 0));
      }
      return persist(next);
    }
    if (evidence === 'manual_admin_clear') {
      return persist(clearAccountWideRuntimeState({ ...currentRuntimeState, routingBlock: null }));
    }
    if (p === 'codex'
      && (evidence === 'credential_update_after_failure' || evidence === 'access_token_still_valid')
      && deriveAccountRuntimeStatus(currentRuntimeState).status === 'auth_invalid') {
      // New credentials invalidate only evidence against the old credentials.
      // Preserve concurrent rate limits, network failures and per-model state.
      const next = { ...currentRuntimeState, authInvalidUntil: 0 };
      if (Number(next.cooldownUntil) <= Number(currentRuntimeState.authInvalidUntil)) {
        next.cooldownUntil = Math.max(0, ...[
          'rateLimitUntil', 'overloadUntil', 'networkUntil', 'serviceUnavailableUntil', 'upstreamErrorUntil'
        ].map(key => Number(next[key]) || 0));
      }
      if (next.lastFailureKind === 'auth_invalid') {
        next.lastError = '';
        next.lastFailureKind = '';
        next.lastFailureReason = '';
        next.lastFailureAt = 0;
        next.consecutiveFailures = 0;
      }
      return persist(next);
    }
    const recheckSucceeded = Boolean(currentRuntimeState.routingBlock)
      && ROUTING_BLOCK_RECHECK_SUCCESS_EVIDENCE.has(evidence);
    return persist(clearAccountWideRuntimeState(recheckSucceeded
      ? { ...currentRuntimeState, routingBlock: null }
      : currentRuntimeState));
  }

  function recordRuntimeSuccess(accountRef, provider, options = {}) {
    return clearRuntimeBlock(accountRef, provider, {
      ...options,
      evidence: options.evidence || 'upstream_success'
    });
  }

  // recordRuntimeState 是服务端管理入口：CLI 的 runtime-state 写请求落到这里。
  function recordRuntimeState(accountRef, provider, runtimeState, baseState = {}) {
    const index = getIndex();
    const ref = normalizeAccountRef(accountRef);
    const p = normalizeProvider(provider);
    if (!index || typeof index.upsertRuntimeState !== 'function' || !ref || !p) return false;
    // 整份替换同样进日志：null 也要记 —— 它是显式清空，oracle 必须按「清空」而不是
    // 「没有事件」处理，否则双读会在「Go 还留着旧文档」这种场景上假阴性。
    recordStatusEvent({
      accountRef: ref,
      provider: p,
      op: 'runtime_state',
      atMs: Date.now(),
      state: runtimeState === undefined ? null : runtimeState
    });
    const current = getAccountState(ref) || {};
    if (!runtimeState || typeof runtimeState !== 'object') {
      const stored = typeof index.upsertAccountState === 'function'
        ? index.upsertAccountState(ref, p, normalizeSynchronizedBaseState(current, baseState))
        : false;
      if (stored && typeof index.clearRuntimeState === 'function') index.clearRuntimeState(ref);
      return stored;
    }
    return index.upsertRuntimeState(
      ref,
      p,
      runtimeState,
      normalizeSynchronizedBaseState(current, baseState)
    );
  }

  function deleteAccount(accountRef) {
    const index = getIndex();
    const ref = normalizeAccountRef(accountRef);
    if (!index || !ref) return false;
    if (typeof index.deleteAccountState === 'function') return index.deleteAccountState(ref);
    if (typeof index.removeAccount === 'function') return index.removeAccount(ref);
    return false;
  }

  function pruneMissing(provider, existingRefs) {
    const index = getIndex();
    const p = normalizeProvider(provider);
    if (!p) return 0;
    const refs = (Array.isArray(existingRefs) ? existingRefs : [])
      .map((accountRef) => normalizeAccountRef(accountRef))
      .filter(Boolean);
    let removed = 0;
    if (index && typeof index.pruneMissingRefs === 'function') {
      removed = Number(index.pruneMissingRefs(p, refs)) || 0;
    }
    if (stateIndexClient && typeof stateIndexClient.pruneMissing === 'function') {
      stateIndexClient.pruneMissing(p, refs);
    }
    return removed;
  }

  return {
    getAccountState,
    syncAccountBaseState,
    setOperationalStatus,
    recordRuntimeState,
    recordRuntimeFailure,
    recordRuntimeSuccess,
    clearRuntimeBlock,
    deleteAccount,
    pruneMissing
  };
}

module.exports = {
  RUNTIME_CLEAR_EVIDENCE,
  createAccountStateService,
  __private: {
    normalizeBaseState,
    normalizeProvider,
    normalizeAccountRef
  }
};
