'use strict';

const {
  deriveAccountRuntimeStatus,
  pickPersistedAccountRuntimeState
} = require('./account-runtime-state');
const { ACCOUNT_RUNTIME_CHANGED } = require('./account-runtime-event-types');
const {
  getApiKeyDisplayName,
  pickOauthDisplayName
} = require('./account-display-identity');
const {
  isApiCredentialAccount,
  resolveRuntimeAuthMode
} = require('../account/runtime-auth-mode');

// 需求：事件持久化 listener 需要账号基础信息，但 producer 不直接写 account_state.db。
function buildAccountRuntimeEventBaseState(account) {
  if (!account) return {};
  const provider = String(account.provider || '').trim().toLowerCase();
  const authMode = resolveRuntimeAuthMode(account);
  const apiCredentialMode = isApiCredentialAccount(account);
  return {
    configured: true,
    apiKeyMode: apiCredentialMode,
    authMode,
    displayName: apiCredentialMode
      ? getApiKeyDisplayName(provider, account)
      : pickOauthDisplayName(account.email, account.displayName)
  };
}

function buildAccountRuntimeChangedEvent(account, previousStatus, source) {
  if (!account) return null;
  const provider = String(account.provider || '').trim().toLowerCase();
  const accountId = String(account.id || '').trim();
  if (!provider || !accountId) return null;
  return {
    provider,
    accountId,
    previousStatus,
    nextStatus: deriveAccountRuntimeStatus(account).status,
    reason: String(account.lastFailureReason || account.lastError || ''),
    source,
    runtimeState: pickPersistedAccountRuntimeState(account),
    baseState: buildAccountRuntimeEventBaseState(account)
  };
}

function createAccountRuntimeEventPublisher(hub) {
  // 需求：server 上游路径统一发布运行态事件，让后续 DB/pool/cache 副作用集中在 listener。
  function publishChanged(account, previousStatus, source) {
    const event = buildAccountRuntimeChangedEvent(account, previousStatus, source);
    if (!event || !hub || typeof hub.emit !== 'function') return [];
    return hub.emit(ACCOUNT_RUNTIME_CHANGED, event);
  }

  return {
    publishChanged
  };
}

module.exports = {
  createAccountRuntimeEventPublisher,
  buildAccountRuntimeChangedEvent,
  buildAccountRuntimeEventBaseState
};
