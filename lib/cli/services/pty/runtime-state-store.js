'use strict';

// Runtime account-state store: the PTY runtime's read/write surface over the
// persisted account state index — runtime-blocked summaries, auth-invalid
// records, api-key mode detection. Extracted from runCliPty; exported names
// match the original closure functions so call sites are unchanged.

const {
  deriveRuntimeStatus,
  isBlockingRuntimeStatus,
  formatRuntimeStatusSummary
} = require('../../../account/runtime-view');
const {
  buildAuthInvalidRuntimeState
} = require('../../../account/runtime-state-builders');
const { readAccountCredentials } = require('../../../server/account-credential-store');
const { createAccountRuntimeGate } = require('../../../server/account-runtime-gate');

function createRuntimeStateStore(deps = {}) {
  const {
    fs,
    aiHomeDir,
    provider: cliName,
    getAccountStateIndex,
    accountStateService,
    getActiveAccountRef,
    getActiveCliAccountId
  } = deps;

  function readCodexApiKeyAccountInfo(accountRef) {
    if (cliName !== 'codex') return { apiKeyMode: false, baseUrl: '' };
    const ref = String(accountRef || '').trim();
    if (!/^acct_[a-f0-9]{20}$/.test(ref)) return { apiKeyMode: false, baseUrl: '' };
    const credentials = readAccountCredentials(fs, aiHomeDir, ref);
    return {
      apiKeyMode: Boolean(String(credentials.OPENAI_API_KEY || '').trim()),
      baseUrl: String(credentials.OPENAI_BASE_URL || '').trim()
    };
  }

  function getPersistedAccountState(accountRef) {
    if (typeof getAccountStateIndex !== 'function') return null;
    const index = getAccountStateIndex();
    if (!index || typeof index.getAccountState !== 'function') return null;
    return index.getAccountState(accountRef) || null;
  }

  function getPersistedRuntimeStatus(accountRef) {
    const row = getPersistedAccountState(accountRef);
    if (!row) return null;
    return deriveRuntimeStatus(row);
  }

  function buildRuntimeBlockedSummary(accountRef) {
    const runtimeStatus = getPersistedRuntimeStatus(accountRef);
    if (!isBlockingRuntimeStatus(runtimeStatus)) return '';
    const displayId = typeof getActiveCliAccountId === 'function' ? getActiveCliAccountId() : '';
    return formatRuntimeStatusSummary(runtimeStatus, displayId || accountRef);
  }

  function buildPersistedRuntimeStateForAuthInvalid(reason) {
    return buildAuthInvalidRuntimeState(reason);
  }

  function buildRuntimeBaseState(accountRef) {
    const row = getPersistedAccountState(accountRef) || {};
    const apiKeyInfo = readCodexApiKeyAccountInfo(accountRef);
    return {
      status: row.status || 'up',
      configured: typeof row.configured === 'boolean' ? row.configured : true,
      apiKeyMode: typeof row.apiKeyMode === 'boolean' ? row.apiKeyMode : apiKeyInfo.apiKeyMode,
      authMode: row.authMode || '',
      displayName: row.displayName || ''
    };
  }

  function persistRuntimeState(runtimeState) {
    const accountRef = getActiveAccountRef();
    const baseState = buildRuntimeBaseState(accountRef);
    if (accountStateService && typeof accountStateService.recordRuntimeFailure === 'function') {
      return accountStateService.recordRuntimeFailure(accountRef, cliName, runtimeState, baseState);
    }
    return false;
  }

  function persistAuthInvalidRuntimeState(reason) {
    return persistRuntimeState(buildPersistedRuntimeStateForAuthInvalid(reason));
  }

  function clearPersistedRuntimeState(accountRef = '') {
    const ref = String(accountRef || getActiveAccountRef() || '').trim();
    const baseState = buildRuntimeBaseState(ref);
    // 运行态恢复统一走门禁（见 account-runtime-gate 的 observeRecovery）：CLI 进程没有
    // 内存池，所以只落库（clear: 'none'）。
    const gate = createAccountRuntimeGate({ accountStateService });
    return gate.observeRecovery({
      account: { accountRef: ref, provider: cliName, ...baseState },
      provider: cliName,
      evidence: 'login_success',
      baseState,
      clear: 'none',
      source: 'cli.pty.login_success'
    });
  }

  return {
    readCodexApiKeyAccountInfo,
    getPersistedAccountState,
    getPersistedRuntimeStatus,
    buildRuntimeBlockedSummary,
    buildPersistedRuntimeStateForAuthInvalid,
    buildRuntimeBaseState,
    persistRuntimeState,
    persistAuthInvalidRuntimeState,
    clearPersistedRuntimeState
  };
}

module.exports = {
  createRuntimeStateStore
};
