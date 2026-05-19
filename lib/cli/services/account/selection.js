'use strict';

const { deriveAccountRuntimeStatus } = require('../../../server/account-runtime-state');
const { buildAuthInvalidRuntimeState } = require('../../../account/runtime-state-builders');
const {
  isSelfRelayApiKeyInfo,
  readApiKeyProfileInfo
} = require('../../../account/self-relay-account');

function createAccountSelectionService(options = {}) {
  const {
    path,
    fs,
    profilesDir,
    getAccountStateIndex,
    getToolAccountIds,
    checkStatus,
    accountStateService,
    accountQueryService,
    refreshIndexedStateForAccount,
    readServerConfig
  } = options;

  function getIndexedState(cliName, accountId) {
    const index = typeof getAccountStateIndex === 'function' ? getAccountStateIndex() : null;
    if (!index) return null;
    if (typeof index.getAccountState === 'function') {
      return index.getAccountState(cliName, accountId);
    }
    return null;
  }

  function isRuntimeSelectable(cliName, accountId) {
    const row = getIndexedState(cliName, accountId);
    const runtimeState = row && (row.runtime_state || row.runtimeState);
    if (!runtimeState || typeof runtimeState !== 'object') return true;
    return deriveAccountRuntimeStatus(runtimeState).status === 'healthy';
  }

  // 需求：自动切换账号时必须先尊重持久运行态，避免把 rate-limited/auth-invalid 账号重新选上。
  function isIndexedRuntimeBlocked(cliName, accountId) {
    return !isRuntimeSelectable(cliName, accountId);
  }

  function readApiKeyInfo(cliName, profileDir, accountName) {
    return readApiKeyProfileInfo({
      fs,
      provider: cliName,
      profileDir,
      accountName
    });
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

  function readCodexAuthTokens(profileDir) {
    try {
      const authPath = path.join(profileDir, '.codex', 'auth.json');
      if (!fs.existsSync(authPath)) return null;
      const authData = JSON.parse(fs.readFileSync(authPath, 'utf8'));
      const tokens = authData && authData.tokens && typeof authData.tokens === 'object' ? authData.tokens : null;
      return tokens;
    } catch (_error) {
      return null;
    }
  }

  function hasRefreshToken(tokens) {
    return !!(tokens && String(tokens.refresh_token || '').trim());
  }

  function hasExpiredCodexAuthToken(profileDir) {
    try {
      const tokens = readCodexAuthTokens(profileDir);
      if (!tokens || hasRefreshToken(tokens)) return false;
      const accessToken = String(tokens.access_token || '').trim();
      if (!accessToken) return false;
      const nowSeconds = Math.floor(Date.now() / 1000);
      return isExpiredJwt(accessToken, nowSeconds);
    } catch (_error) {
      return false;
    }
  }

  function isLocallyAuthExpired(cliName, profileDir) {
    return cliName === 'codex' && hasExpiredCodexAuthToken(profileDir);
  }

  function isSelfRelayApiKey(cliName, apiKeyInfo) {
    const serverConfig = typeof readServerConfig === 'function' ? (readServerConfig() || {}) : {};
    return isSelfRelayApiKeyInfo(apiKeyInfo, serverConfig.port);
  }

  function upsertIndexedBaseState(cliName, accountId, state) {
    if (!accountStateService || typeof accountStateService.syncAccountBaseState !== 'function') return false;
    return accountStateService.syncAccountBaseState(cliName, accountId, state);
  }

  function persistLocalAuthExpiredRuntimeState(cliName, accountId, displayName = '') {
    const row = getIndexedState(cliName, accountId) || {};
    const baseState = {
      status: row.status || 'up',
      configured: true,
      apiKeyMode: false,
      authMode: row.authMode || row.auth_mode || '',
      displayName: displayName || row.displayName || row.display_name || ''
    };
    if (accountStateService && typeof accountStateService.recordRuntimeFailure === 'function') {
      return accountStateService.recordRuntimeFailure(
        cliName,
        accountId,
        buildAuthInvalidRuntimeState('local_unrefreshable_token_expired'),
        baseState
      );
    }
    return false;
  }

  function getNextAvailableId(cliName, currentId, options = {}) {
    const refreshSnapshot = options.refreshSnapshot !== false;
    const allowApiKey = options.allowApiKey !== false;
    const current = String(currentId || '').trim();
    for (let i = 0; i < 128; i += 1) {
      const indexedCandidate = accountQueryService && typeof accountQueryService.getNextSchedulableAccountId === 'function'
        ? accountQueryService.getNextSchedulableAccountId(cliName, current)
        : null;
      if (!indexedCandidate) break;
      const profileDir = path.join(profilesDir, cliName, indexedCandidate);
      if (!fs.existsSync(profileDir)) {
        getToolAccountIds(cliName);
        continue;
      }
      if (isIndexedRuntimeBlocked(cliName, indexedCandidate)) {
        continue;
      }
      if (isLocallyAuthExpired(cliName, profileDir)) {
        persistLocalAuthExpiredRuntimeState(cliName, indexedCandidate);
        upsertIndexedBaseState(cliName, indexedCandidate, {
          configured: true,
          apiKeyMode: false,
          remainingPct: null
        });
        continue;
      }
      const derivedState = refreshIndexedStateForAccount(cliName, indexedCandidate, { refreshSnapshot });
      const configured = Boolean(derivedState && derivedState.configured);
      const apiKeyMode = Boolean(derivedState && derivedState.apiKeyMode);
      const schedulable = String(derivedState && derivedState.schedulableStatus || '') === 'schedulable';
      upsertIndexedBaseState(cliName, indexedCandidate, {
        configured,
        apiKeyMode,
        remainingPct: derivedState ? derivedState.remainingPct : null,
        displayName: derivedState ? derivedState.displayName : null
      });
      if (configured && !apiKeyMode && schedulable) {
        return indexedCandidate;
      }
    }

    const toolDir = path.join(profilesDir, cliName);
    if (!fs.existsSync(toolDir)) return null;
    const ids = fs.readdirSync(toolDir)
      .filter((f) => /^\d+$/.test(f) && fs.statSync(path.join(toolDir, f)).isDirectory());

    let bestId = null;
    let bestRemaining = -1;
    ids.forEach((id) => {
      if (id === current) return;
      if (isIndexedRuntimeBlocked(cliName, id)) return;
      const profileDir = path.join(toolDir, id);
      const { configured, accountName } = checkStatus(cliName, profileDir);
      const apiKeyInfo = readApiKeyInfo(cliName, profileDir, accountName);
      const apiKeyMode = apiKeyInfo.apiKeyMode;
      if (!apiKeyMode && isLocallyAuthExpired(cliName, profileDir)) {
        persistLocalAuthExpiredRuntimeState(cliName, id, accountName);
        upsertIndexedBaseState(cliName, id, {
          configured: true,
          apiKeyMode: false,
          remainingPct: null
        });
        return;
      }
      if (!configured || isSelfRelayApiKey(cliName, apiKeyInfo)) {
        upsertIndexedBaseState(cliName, id, {
          configured,
          apiKeyMode,
          remainingPct: null
        });
        return;
      }
      if (apiKeyMode) {
        upsertIndexedBaseState(cliName, id, {
          configured: true,
          apiKeyMode: true,
          remainingPct: null
        });
        if (!allowApiKey) return;
        if (bestId === null) bestId = id;
        return;
      }
      const derivedState = refreshIndexedStateForAccount(cliName, id, { refreshSnapshot });
      const remaining = derivedState && Number.isFinite(Number(derivedState.remainingPct))
        ? Number(derivedState.remainingPct)
        : -1;
      upsertIndexedBaseState(cliName, id, {
        configured: true,
        apiKeyMode: false,
        remainingPct: remaining >= 0 ? remaining : null,
        displayName: derivedState ? derivedState.displayName : null
      });
      if (!derivedState || derivedState.schedulableStatus !== 'schedulable') return;
      if (remaining > bestRemaining) {
        bestRemaining = remaining;
        bestId = id;
        return;
      }
      if (remaining === bestRemaining && bestId !== null && Number(id) < Number(bestId)) {
        bestId = id;
      }
      if (bestId === null) bestId = id;
    });

    return bestId;
  }

  function getFirstLoginableOAuthId(cliName, currentId) {
    const current = String(currentId || '').trim();
    const toolDir = path.join(profilesDir, cliName);
    if (!fs.existsSync(toolDir)) return null;
    const ids = fs.readdirSync(toolDir)
      .filter((entryName) => /^\d+$/.test(entryName) && fs.statSync(path.join(toolDir, entryName)).isDirectory())
      .sort((left, right) => Number(left) - Number(right));

    for (const id of ids) {
      if (id === current) continue;
      if (isIndexedRuntimeBlocked(cliName, id)) continue;
      const profileDir = path.join(toolDir, id);
      const { configured, accountName } = checkStatus(cliName, profileDir);
      const apiKeyInfo = readApiKeyInfo(cliName, profileDir, accountName);
      const apiKeyMode = apiKeyInfo.apiKeyMode || String(accountName || '').startsWith('API Key');
      if (!configured || apiKeyMode || isSelfRelayApiKey(cliName, apiKeyInfo)) {
        upsertIndexedBaseState(cliName, id, {
          configured,
          apiKeyMode,
          remainingPct: null
        });
        continue;
      }
      if (isLocallyAuthExpired(cliName, profileDir)) {
        persistLocalAuthExpiredRuntimeState(cliName, id, accountName);
        upsertIndexedBaseState(cliName, id, {
          configured: true,
          apiKeyMode: false,
          remainingPct: null
        });
        continue;
      }
      upsertIndexedBaseState(cliName, id, {
        configured: true,
        apiKeyMode: false,
        remainingPct: null,
        displayName: accountName && accountName !== 'Unknown' ? accountName : null
      });
      return id;
    }

    return null;
  }

  function getNextLoginableId(cliName, currentId, options = {}) {
    const schedulableOAuthId = getNextAvailableId(cliName, currentId, {
      ...options,
      allowApiKey: false
    });
    if (schedulableOAuthId) return schedulableOAuthId;
    return getFirstLoginableOAuthId(cliName, currentId);
  }

  return {
    getNextAvailableId,
    getNextLoginableId
  };
}

module.exports = {
  createAccountSelectionService
};
