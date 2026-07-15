'use strict';

const { deriveAccountRuntimeStatus } = require('../../../server/account-runtime-state');
const { buildAuthInvalidRuntimeState } = require('../../../account/runtime-state-builders');
const { isSelfRelayApiKeyInfo } = require('../../../account/self-relay-account');
const { readAccountCredentialRecord } = require('../../../server/account-credential-store');
const {
  listCliAccountRefRecords,
  resolveAccountRefByCliId
} = require('../../../server/account-ref-store');

function createAccountSelectionService(options = {}) {
  const {
    fs,
    aiHomeDir,
    getAccountStateIndex,
    checkStatus,
    accountStateService,
    accountQueryService,
    refreshIndexedStateForAccount,
    readServerConfig
  } = options;

  function getIndexedState(accountRef) {
    const index = typeof getAccountStateIndex === 'function' ? getAccountStateIndex() : null;
    return index && typeof index.getAccountState === 'function'
      ? index.getAccountState(accountRef)
      : null;
  }

  function isRuntimeSelectable(accountRef) {
    const row = getIndexedState(accountRef);
    const runtimeState = row && row.runtimeState;
    return !runtimeState || deriveAccountRuntimeStatus(runtimeState).status === 'healthy';
  }

  function listKnownAccounts(provider) {
    return listCliAccountRefRecords(fs, aiHomeDir, provider, { bestEffort: true })
      .filter((record) => /^\d+$/.test(record.cliAccountId))
      .sort((left, right) => Number(left.cliAccountId) - Number(right.cliAccountId));
  }

  function readApiKeyInfo(provider, credentialRecord) {
    const credentials = credentialRecord && credentialRecord.env || {};
    const keyByProvider = {
      codex: credentials.OPENAI_API_KEY,
      claude: credentials.ANTHROPIC_API_KEY || credentials.ANTHROPIC_AUTH_TOKEN,
      gemini: credentials.GEMINI_API_KEY || credentials.GOOGLE_API_KEY
    };
    const baseUrlByProvider = {
      codex: credentials.OPENAI_BASE_URL,
      claude: credentials.ANTHROPIC_BASE_URL,
      gemini: credentials.GEMINI_BASE_URL
    };
    const apiKey = String(keyByProvider[provider] || '').trim();
    return {
      apiKeyMode: Boolean(apiKey),
      apiKey,
      baseUrl: String(baseUrlByProvider[provider] || '').trim()
    };
  }

  function parseJwtPayload(token) {
    const text = String(token || '').trim();
    if (!text) return null;
    const parts = text.split('.');
    if (parts.length < 2) return null;
    try {
      const normalized = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
      const decoded = Buffer.from(`${normalized}${padding}`, 'base64').toString('utf8');
      const parsed = JSON.parse(decoded);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (_error) {
      return null;
    }
  }

  function isExpiredJwt(token, nowSeconds) {
    const payload = parseJwtPayload(token);
    const exp = Number(payload && payload.exp);
    return Number.isFinite(exp) && exp > 0 && exp <= nowSeconds;
  }

  function hasRefreshToken(tokens) {
    return !!(tokens && String(tokens.refresh_token || '').trim());
  }

  function isLocallyAuthExpired(provider, credentialRecord) {
    if (provider !== 'codex') return false;
    const auth = credentialRecord && credentialRecord.nativeAuth && credentialRecord.nativeAuth.auth;
    const tokens = auth && auth.tokens && typeof auth.tokens === 'object' ? auth.tokens : null;
    if (!tokens || hasRefreshToken(tokens)) return false;
    const accessToken = String(tokens.access_token || '').trim();
    return accessToken
      ? isExpiredJwt(accessToken, Math.floor(Date.now() / 1000))
      : false;
  }

  function isSelfRelayApiKey(cliName, apiKeyInfo) {
    const serverConfig = typeof readServerConfig === 'function' ? (readServerConfig() || {}) : {};
    return isSelfRelayApiKeyInfo(apiKeyInfo, serverConfig.port);
  }

  function upsertIndexedBaseState(accountRef, provider, state) {
    if (!accountStateService || typeof accountStateService.syncAccountBaseState !== 'function') return false;
    return accountStateService.syncAccountBaseState(accountRef, provider, state);
  }

  function persistLocalAuthExpiredRuntimeState(accountRef, provider, displayName = '') {
    const row = getIndexedState(accountRef) || {};
    const baseState = {
      status: row.status || 'up',
      configured: true,
      apiKeyMode: false,
      authMode: row.authMode || '',
      displayName: displayName || row.displayName || ''
    };
    if (accountStateService && typeof accountStateService.recordRuntimeFailure === 'function') {
      return accountStateService.recordRuntimeFailure(
        accountRef,
        provider,
        buildAuthInvalidRuntimeState('local_unrefreshable_token_expired'),
        baseState
      );
    }
    return false;
  }

  function getCurrentAccountRef(provider, currentCliAccountId) {
    const account = resolveAccountRefByCliId(
      fs,
      aiHomeDir,
      provider,
      currentCliAccountId,
      { bestEffort: true }
    );
    return String(account && account.accountRef || '');
  }

  function evaluateAccount(provider, record, options = {}) {
    const accountRef = record.accountRef;
    const row = getIndexedState(accountRef);
    if (row && String(row.status || 'up') !== 'up') return null;
    if (!isRuntimeSelectable(accountRef)) return null;

    const credentialRecord = readAccountCredentialRecord(fs, aiHomeDir, accountRef);
    if (!credentialRecord || credentialRecord.provider !== provider) return null;
    const status = checkStatus(provider, accountRef) || {};
    const configured = Boolean(status.configured);
    const accountName = String(status.accountName || '').trim();
    const apiKeyInfo = readApiKeyInfo(provider, credentialRecord);
    const apiKeyMode = apiKeyInfo.apiKeyMode;
    if (!configured || isSelfRelayApiKey(provider, apiKeyInfo)) {
      upsertIndexedBaseState(accountRef, provider, { configured, apiKeyMode, remainingPct: null });
      return null;
    }
    if (!apiKeyMode && isLocallyAuthExpired(provider, credentialRecord)) {
      persistLocalAuthExpiredRuntimeState(accountRef, provider, accountName);
      upsertIndexedBaseState(accountRef, provider, {
        configured: true,
        apiKeyMode: false,
        remainingPct: null,
        displayName: accountName
      });
      return null;
    }

    if (apiKeyMode) {
      upsertIndexedBaseState(accountRef, provider, {
        configured: true,
        apiKeyMode: true,
        remainingPct: null,
        displayName: accountName
      });
      return options.allowApiKey === false ? null : { record, remainingPct: -1, apiKeyMode: true };
    }

    const derivedState = refreshIndexedStateForAccount(provider, accountRef, {
      refreshSnapshot: options.refreshSnapshot !== false
    });
    const remainingPct = derivedState && Number.isFinite(Number(derivedState.remainingPct))
      ? Number(derivedState.remainingPct)
      : -1;
    upsertIndexedBaseState(accountRef, provider, {
      configured: true,
      apiKeyMode: false,
      remainingPct: remainingPct >= 0 ? remainingPct : null,
      displayName: derivedState && derivedState.displayName || accountName
    });
    if (!derivedState || derivedState.schedulableStatus !== 'schedulable') return null;
    return { record, remainingPct, apiKeyMode: false };
  }

  function getNextAvailableId(provider, currentId, options = {}) {
    const refreshSnapshot = options.refreshSnapshot !== false;
    const allowApiKey = options.allowApiKey !== false;
    const currentRef = getCurrentAccountRef(provider, currentId);
    const indexedCandidateRef = accountQueryService
      && typeof accountQueryService.getNextSchedulableAccountRef === 'function'
      ? accountQueryService.getNextSchedulableAccountRef(provider, currentRef)
      : '';
    const records = listKnownAccounts(provider)
      .filter((record) => record.accountRef !== currentRef)
      .sort((left, right) => {
        if (left.accountRef === indexedCandidateRef) return -1;
        if (right.accountRef === indexedCandidateRef) return 1;
        return Number(left.cliAccountId) - Number(right.cliAccountId);
      });

    let best = null;
    let bestRemaining = -1;
    records.forEach((record) => {
      const candidate = evaluateAccount(provider, record, { refreshSnapshot, allowApiKey });
      if (!candidate) return;
      if (candidate.apiKeyMode && best) return;
      if (!candidate.apiKeyMode && (best == null || candidate.remainingPct > bestRemaining)) {
        best = candidate;
        bestRemaining = candidate.remainingPct;
      } else if (best == null) {
        best = candidate;
      }
    });
    return best ? best.record.cliAccountId : null;
  }

  function getFirstLoginableOAuthId(provider, currentId) {
    const currentRef = getCurrentAccountRef(provider, currentId);
    for (const record of listKnownAccounts(provider)) {
      if (record.accountRef === currentRef || !isRuntimeSelectable(record.accountRef)) continue;
      const row = getIndexedState(record.accountRef);
      if (row && String(row.status || 'up') !== 'up') continue;
      const credentialRecord = readAccountCredentialRecord(fs, aiHomeDir, record.accountRef);
      const status = checkStatus(provider, record.accountRef) || {};
      const accountName = String(status.accountName || '').trim();
      const apiKeyInfo = readApiKeyInfo(provider, credentialRecord);
      if (!status.configured || apiKeyInfo.apiKeyMode || isSelfRelayApiKey(provider, apiKeyInfo)) continue;
      if (isLocallyAuthExpired(provider, credentialRecord)) {
        persistLocalAuthExpiredRuntimeState(record.accountRef, provider, accountName);
        continue;
      }
      upsertIndexedBaseState(record.accountRef, provider, {
        configured: true,
        apiKeyMode: false,
        remainingPct: null,
        displayName: accountName && accountName !== 'Unknown' ? accountName : null
      });
      return record.cliAccountId;
    }

    return null;
  }

  function getNextLoginableId(provider, currentId, options = {}) {
    const schedulableOAuthId = getNextAvailableId(provider, currentId, {
      ...options,
      allowApiKey: false
    });
    if (schedulableOAuthId) return schedulableOAuthId;
    return getFirstLoginableOAuthId(provider, currentId);
  }

  return {
    getNextAvailableId,
    getNextLoginableId
  };
}

module.exports = {
  createAccountSelectionService
};
