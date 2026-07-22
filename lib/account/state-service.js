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

const RUNTIME_CLEAR_EVIDENCE = new Set([
  'direct_usage_success',
  'direct_rate_limit_success',
  'agy_oauth_credentials_recoverable',
  'api_key_config_verified',
  'credential_config_verified',
  'login_success',
  'manual_admin_clear',
  'models_probe_success',
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

function clearAccountWideRuntimeState(runtimeState) {
  if (!runtimeState || typeof runtimeState !== 'object') return null;
  const next = clearExpiredAccountModelState(clearBlockingAccountRuntimeState({ ...runtimeState }));
  const hasModelCooldowns = next.modelCooldowns && Object.keys(next.modelCooldowns).length > 0;
  const hasModelFailureStreaks = next.modelFailureStreaks
    && Object.keys(next.modelFailureStreaks).length > 0;
  return hasModelCooldowns || hasModelFailureStreaks ? next : null;
}

function canClearRuntimeBlock(provider, runtimeState, evidence) {
  if (!isNonRecoverableAgyAuthInvalidBlock(provider, deriveAccountRuntimeStatus(runtimeState))) return true;
  return NON_RECOVERABLE_RUNTIME_CLEAR_EVIDENCE.has(evidence);
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
    let updated = false;
    if (index && typeof index.upsertAccountState === 'function') {
      updated = index.upsertAccountState(ref, p, state);
    }
    if (stateIndexClient && typeof stateIndexClient.upsert === 'function') {
      stateIndexClient.upsert(ref, p, state);
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
    if (stateIndexClient && typeof stateIndexClient.upsert === 'function') {
      stateIndexClient.upsert(ref, p, nextState);
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
    return index.upsertRuntimeState(ref, p, runtimeState, normalizeBaseState(current, baseState));
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
    const nextBaseState = normalizeBaseState(current, baseState);
    if (!currentRuntimeState) {
      if (typeof index.upsertAccountState === 'function') {
        return index.upsertAccountState(ref, p, nextBaseState);
      }
      return false;
    }
    if (!canClearRuntimeBlock(p, currentRuntimeState, evidence)) return false;
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
