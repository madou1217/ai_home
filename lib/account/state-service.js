'use strict';

const {
  writeAccountStatusFile,
  normalizeAccountStatusValue
} = require('./status-file');
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
  'token_refresh_success',
  'upstream_success',
  'verified_usage_success'
]);
const NON_RECOVERABLE_RUNTIME_CLEAR_EVIDENCE = new Set([
  'login_success',
  'manual_admin_clear'
]);

function normalizeProvider(provider) {
  return String(provider || '').trim().toLowerCase();
}

function normalizeAccountId(accountId) {
  const id = String(accountId || '').trim();
  return /^\d+$/.test(id) ? id : '';
}

function normalizeDisplayName(value) {
  return String(value || '').trim();
}

function readRowValue(row, camelName, snakeName) {
  if (!row || typeof row !== 'object') return undefined;
  if (Object.prototype.hasOwnProperty.call(row, camelName)) return row[camelName];
  if (Object.prototype.hasOwnProperty.call(row, snakeName)) return row[snakeName];
  return undefined;
}

function readRowBoolean(row, camelName, snakeName) {
  const value = readRowValue(row, camelName, snakeName);
  if (typeof value === 'boolean') return value;
  if (value == null) return false;
  return Number(value) === 1;
}

function readRowString(row, camelName, snakeName) {
  const value = readRowValue(row, camelName, snakeName);
  return String(value || '').trim();
}

function readRowNumber(row, camelName, snakeName) {
  const value = readRowValue(row, camelName, snakeName);
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function normalizeBaseState(row, overrides = {}) {
  const status = normalizeAccountStatusValue(
    overrides.status != null ? overrides.status : readRowString(row, 'status', 'status')
  ) || 'up';
  const configured = typeof overrides.configured === 'boolean'
    ? overrides.configured
    : readRowBoolean(row, 'configured', 'configured');
  const apiKeyMode = typeof overrides.apiKeyMode === 'boolean'
    ? overrides.apiKeyMode
    : readRowBoolean(row, 'apiKeyMode', 'api_key_mode');
  const authMode = overrides.authMode != null
    ? String(overrides.authMode || '').trim()
    : readRowString(row, 'authMode', 'auth_mode');
  const displayName = overrides.displayName != null
    ? normalizeDisplayName(overrides.displayName)
    : readRowString(row, 'displayName', 'display_name');
  const remainingPct = overrides.remainingPct !== undefined
    ? overrides.remainingPct
    : readRowNumber(row, 'remainingPct', 'remaining_pct');

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
  const hasModelFailures = next.modelFailures && Object.keys(next.modelFailures).length > 0;
  return hasModelCooldowns || hasModelFailures ? next : null;
}

function canClearRuntimeBlock(provider, runtimeState, evidence) {
  if (!isNonRecoverableAgyAuthInvalidBlock(provider, deriveAccountRuntimeStatus(runtimeState))) return true;
  return NON_RECOVERABLE_RUNTIME_CLEAR_EVIDENCE.has(evidence);
}

function createAccountStateService(options = {}) {
  const {
    fs,
    getProfileDir,
    stateIndexClient
  } = options;

  function getIndex() {
    if (options.accountStateIndex) return options.accountStateIndex;
    if (typeof options.getAccountStateIndex !== 'function') return null;
    try {
      return options.getAccountStateIndex();
    } catch (_error) {
      return null;
    }
  }

  function getAccountState(provider, accountId) {
    const index = getIndex();
    const p = normalizeProvider(provider);
    const id = normalizeAccountId(accountId);
    if (!index || typeof index.getAccountState !== 'function' || !p || !id) return null;
    return index.getAccountState(p, id) || null;
  }

  function writeStatusMirror(provider, accountId, status) {
    if (!fs || typeof getProfileDir !== 'function') return false;
    return writeAccountStatusFile(fs, getProfileDir(provider, accountId), status);
  }

  function syncAccountBaseState(provider, accountId, state = {}) {
    const index = getIndex();
    const p = normalizeProvider(provider);
    const id = normalizeAccountId(accountId);
    if (!p || !id) return false;
    let updated = false;
    if (index && typeof index.upsertAccountState === 'function') {
      updated = index.upsertAccountState(p, id, state);
    }
    if (stateIndexClient && typeof stateIndexClient.upsert === 'function') {
      stateIndexClient.upsert(p, id, state);
      updated = true;
    }
    return updated;
  }

  function setOperationalStatus(provider, accountId, status, baseState = {}) {
    const index = getIndex();
    const p = normalizeProvider(provider);
    const id = normalizeAccountId(accountId);
    const normalizedStatus = normalizeAccountStatusValue(status);
    if (!p || !id || !normalizedStatus) return false;

    const current = getAccountState(p, id) || {};
    let updated = false;
    if (index && current.account_id && typeof index.setStatus === 'function') {
      updated = index.setStatus(p, id, normalizedStatus);
    }
    const nextState = normalizeBaseState(current, {
      ...baseState,
      status: normalizedStatus
    });
    if (!updated && index && typeof index.upsertAccountState === 'function') {
      updated = index.upsertAccountState(p, id, nextState);
    }
    if (stateIndexClient && typeof stateIndexClient.upsert === 'function') {
      stateIndexClient.upsert(p, id, nextState);
      updated = true;
    }
    if (updated) writeStatusMirror(p, id, normalizedStatus);
    return !!updated;
  }

  function recordRuntimeFailure(provider, accountId, runtimeState, baseState = {}) {
    const index = getIndex();
    const p = normalizeProvider(provider);
    const id = normalizeAccountId(accountId);
    if (!index || typeof index.upsertRuntimeState !== 'function' || !p || !id) return false;
    const current = getAccountState(p, id) || {};
    return index.upsertRuntimeState(p, id, runtimeState, normalizeBaseState(current, baseState));
  }

  function clearRuntimeBlock(provider, accountId, options = {}) {
    const evidence = String(options.evidence || '').trim();
    if (!RUNTIME_CLEAR_EVIDENCE.has(evidence)) return false;
    const index = getIndex();
    const p = normalizeProvider(provider);
    const id = normalizeAccountId(accountId);
    if (!index || typeof index.upsertRuntimeState !== 'function' || !p || !id) return false;
    const current = getAccountState(p, id) || {};
    const currentRuntimeState = current.runtime_state || current.runtimeState;
    const baseState = options.baseState && typeof options.baseState === 'object'
      ? options.baseState
      : options;
    const nextBaseState = normalizeBaseState(current, baseState);
    if (!currentRuntimeState) {
      if (typeof index.upsertAccountState === 'function') {
        return index.upsertAccountState(p, id, nextBaseState);
      }
      return false;
    }
    if (!canClearRuntimeBlock(p, currentRuntimeState, evidence)) return false;
    return index.upsertRuntimeState(
      p,
      id,
      clearAccountWideRuntimeState(currentRuntimeState),
      nextBaseState
    );
  }

  function recordRuntimeSuccess(provider, accountId, options = {}) {
    return clearRuntimeBlock(provider, accountId, {
      ...options,
      evidence: options.evidence || 'upstream_success'
    });
  }

  function deleteAccount(provider, accountId) {
    const index = getIndex();
    const p = normalizeProvider(provider);
    const id = normalizeAccountId(accountId);
    if (!index || !p || !id) return false;
    if (typeof index.deleteAccountState === 'function') return index.deleteAccountState(p, id);
    if (typeof index.removeAccount === 'function') return index.removeAccount(p, id);
    return false;
  }

  function pruneMissing(provider, existingIds) {
    const index = getIndex();
    const p = normalizeProvider(provider);
    if (!p) return 0;
    const ids = (Array.isArray(existingIds) ? existingIds : [])
      .map((id) => normalizeAccountId(id))
      .filter(Boolean);
    let removed = 0;
    if (index && typeof index.pruneMissingIds === 'function') {
      removed = Number(index.pruneMissingIds(p, ids)) || 0;
    }
    if (stateIndexClient && typeof stateIndexClient.pruneMissing === 'function') {
      stateIndexClient.pruneMissing(p, ids);
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
    normalizeAccountId
  }
};
