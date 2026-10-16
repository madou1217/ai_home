'use strict';

const { normalizeAccountStatusValue } = require('./status-file');
const {
  clearBlockingAccountRuntimeState,
  clearExpiredAccountModelState,
  deriveAccountRuntimeStatus
} = require('../server/account-runtime-state');
const {
  isNonRecoverableAgyAuthInvalidBlock
} = require('./agy-auth-recovery');
const { sanitizeBaseState } = require('./state-sync-policy');
const { recoverQuotaRuntimeState, trustedCodexSnapshot } = require('./quota-runtime-recovery');

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

function normalizeProvider(provider) {
  return String(provider || '').trim().toLowerCase();
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
// 与非地区类 permission_denied 仍只能人工清除）与其它 provider 都不受本分支影响。
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

  function setOperationalStatus(accountRef, provider, status, baseState = {}) {
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
    return !!updated;
  }

  function recordRuntimeFailure(accountRef, provider, runtimeState, baseState = {}) {
    const index = getIndex();
    const ref = normalizeAccountRef(accountRef);
    const p = normalizeProvider(provider);
    if (!index || typeof index.upsertRuntimeState !== 'function' || !ref || !p) return false;
    const current = getAccountState(ref) || {};
    return index.upsertRuntimeState(
      ref,
      p,
      runtimeState,
      normalizeSynchronizedBaseState(current, baseState)
    );
  }

  function clearRuntimeBlock(accountRef, provider, options = {}) {
    const evidence = String(options.evidence || '').trim();
    if (!RUNTIME_CLEAR_EVIDENCE.has(evidence)) return false;
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
    if (!currentRuntimeState) {
      if (typeof index.upsertAccountState === 'function') {
        return index.upsertAccountState(ref, p, nextBaseState);
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
      return next !== currentRuntimeState
        ? index.upsertRuntimeState(ref, p, next, nextBaseState) : false;
    }
    // agy 地区资格块可被成功的用量探测推翻（见 isAgyRegionBlock 注释），不落进下面的
    // routingBlock 硬闸门；CLI 刷新（verified_usage_success）与池重建收敛（agy_usage_probe_verified）
    // 共用同一谓词，两条路径的判定不会分叉。
    if (AGY_REGION_BLOCK_CLEAR_EVIDENCE.has(evidence)
      && isAgyRegionBlock(p, currentRuntimeState)
      && hasProbeEvidenceNewerThanFailure(options.usageSnapshot, currentRuntimeState)) {
      return index.upsertRuntimeState(
        ref,
        p,
        clearAccountWideRuntimeState({ ...currentRuntimeState, routingBlock: null }),
        nextBaseState
      );
    }
    if (currentRuntimeState.routingBlock && evidence !== 'manual_admin_clear') return false;
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
      return index.upsertRuntimeState(ref, p, next, nextBaseState);
    }
    if (evidence === 'manual_admin_clear') {
      return index.upsertRuntimeState(ref, p, clearAccountWideRuntimeState({ ...currentRuntimeState, routingBlock: null }), nextBaseState);
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
      return index.upsertRuntimeState(ref, p, next, nextBaseState);
    }
    return index.upsertRuntimeState(
      ref,
      p,
      clearAccountWideRuntimeState(currentRuntimeState),
      nextBaseState
    );
  }

  function recordRuntimeSuccess(accountRef, provider, options = {}) {
    return clearRuntimeBlock(accountRef, provider, {
      ...options,
      evidence: options.evidence || 'upstream_success'
    });
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
