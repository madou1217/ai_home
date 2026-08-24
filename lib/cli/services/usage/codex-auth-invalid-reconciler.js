'use strict';

const {
  normalizeCodexRefreshToken,
  parseIsoTimestampMs,
  parseJwtExpiryMs,
  extractCodexMetadata
} = require('../../../account/codex-auth-metadata');
const {
  refreshCodexAccessToken: defaultRefreshCodexAccessToken
} = require('../../../server/codex-token-refresh');
const {
  fetchWithTimeout: defaultFetchWithTimeout
} = require('../../../server/http-utils');
const { readAccountNativeAuth } = require('../../../server/account-credential-store');
const { isAccountRef } = require('../../../server/account-ref-store');
const {
  ACCOUNT_RECOVERY_REASON_PREFIX
} = require('../../../account/account-recovery-state');

const DEFAULT_CONCURRENCY = 2;
const DEFAULT_REFRESH_TIMEOUT_MS = 15_000;
const DEFAULT_OPENAI_OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const ACCOUNT_RECOVERY_BLOCK_MS = 365 * 24 * 60 * 60 * 1000;

function normalizeAccountRef(accountRef) {
  const ref = String(accountRef || '').trim();
  return isAccountRef(ref) ? ref : '';
}

function normalizeProvider(provider) {
  return String(provider || '').trim().toLowerCase();
}

function isDirectHttpStatus401(reason) {
  return String(reason || '').toLowerCase().includes('direct_http_status_401');
}

function isAuthInvalidReauthRequired(reason) {
  return String(reason || '').toLowerCase().includes('auth_invalid_reauth_required');
}

function getTokens(authJson) {
  return authJson && authJson.tokens && typeof authJson.tokens === 'object'
    ? authJson.tokens
    : null;
}

function getRefreshToken(authJson) {
  const tokens = getTokens(authJson);
  return normalizeCodexRefreshToken(tokens && (tokens.refresh_token || tokens.refreshToken));
}

function getAccessToken(authJson) {
  const tokens = getTokens(authJson);
  return String(tokens && (tokens.access_token || tokens.accessToken) || '').trim();
}

function getIdToken(authJson) {
  const tokens = getTokens(authJson);
  return String(tokens && (tokens.id_token || tokens.idToken) || '').trim();
}

function getUpstreamAccountId(authJson) {
  const tokens = getTokens(authJson);
  return String(tokens && tokens.account_id || '').trim();
}

function resolveTokenExpiresAt(authJson) {
  return parseJwtExpiryMs(getAccessToken(authJson)) || parseIsoTimestampMs(authJson && authJson.expired) || null;
}

function parseRefreshTimeoutMs(env) {
  const raw = Number(env && env.AIH_CODEX_TOKEN_REFRESH_TIMEOUT_MS);
  if (!Number.isFinite(raw)) return DEFAULT_REFRESH_TIMEOUT_MS;
  return Math.max(2_000, Math.min(60_000, Math.floor(raw)));
}

function buildRefreshAccount(accountRef, authJson) {
  const metadata = extractCodexMetadata(authJson || {});
  return {
    accountRef,
    provider: 'codex',
    upstreamAccountId: getUpstreamAccountId(authJson),
    accessToken: getAccessToken(authJson),
    idToken: getIdToken(authJson),
    refreshToken: getRefreshToken(authJson),
    tokenExpiresAt: resolveTokenExpiresAt(authJson),
    oauthClientId: metadata.clientId
  };
}

function getFailureText(result) {
  if (!result || typeof result !== 'object') return '';
  return [
    result.reason,
    result.error,
    result.detail,
    result.status
  ].map((value) => String(value || '').trim()).filter(Boolean).join(' ').toLowerCase();
}

function isSessionInvalidRefreshFailure(result) {
  const reason = String(result && result.reason || '').trim().toLowerCase();
  if (reason === 'missing_refresh_token') return true;
  if (reason === 'invalid_refresh_token') return true;
  if (reason === 'refresh_http_401' || reason === 'refresh_http_403') return true;

  const text = getFailureText(result);
  return text.includes('app_session_terminated')
    || text.includes('invalid_refresh_token')
    || text.includes('invalid_grant')
    || text.includes('session has ended')
    || text.includes('please log in again');
}

function createScheduler(processObj) {
  if (processObj && typeof processObj.nextTick === 'function') {
    return (fn) => processObj.nextTick(fn);
  }
  if (typeof setImmediate === 'function') return (fn) => setImmediate(fn);
  return (fn) => setTimeout(fn, 0);
}

function createCodexAuthInvalidReconciler(options = {}) {
  const {
    fs,
    accountStateService,
    accountArtifactHooks,
    aiHomeDir
  } = options;
  const processObj = options.processObj || process;
  const env = processObj.env || {};
  const refreshCodexAccessToken = typeof options.refreshCodexAccessToken === 'function'
    ? options.refreshCodexAccessToken
    : defaultRefreshCodexAccessToken;
  const fetchWithTimeout = typeof options.fetchWithTimeout === 'function'
    ? options.fetchWithTimeout
    : defaultFetchWithTimeout;
  const schedule = typeof options.schedule === 'function' ? options.schedule : createScheduler(processObj);
  const concurrency = Math.max(1, Math.min(20, Number(options.concurrency) || DEFAULT_CONCURRENCY));
  const queue = [];
  const pendingByAccountRef = new Map();
  const idleResolvers = [];
  let running = 0;
  let scheduled = false;

  function readAuthSnapshot(accountRef) {
    const nativeAuth = readAccountNativeAuth(fs, aiHomeDir, accountRef);
    const authJson = nativeAuth && nativeAuth.auth && typeof nativeAuth.auth === 'object'
      ? nativeAuth.auth
      : null;
    return { authJson };
  }

  function retainAccount(accountRef, reason) {
    const normalizedReason = String(reason || 'auth_invalid').trim().slice(0, 120) || 'auth_invalid';
    const currentState = accountStateService && typeof accountStateService.getAccountState === 'function'
      ? (accountStateService.getAccountState(accountRef) || {})
      : {};
    const currentRuntimeState = currentState.runtimeState && typeof currentState.runtimeState === 'object'
      ? currentState.runtimeState
      : {};
    const now = Date.now();
    const blockedUntil = Math.max(
      Number(currentRuntimeState.cooldownUntil) || 0,
      Number(currentRuntimeState.authInvalidUntil) || 0,
      now + ACCOUNT_RECOVERY_BLOCK_MS
    );
    const recoveryReason = `${ACCOUNT_RECOVERY_REASON_PREFIX}${normalizedReason}`;
    const baseState = {
      configured: currentState.configured !== false,
      apiKeyMode: false,
      authMode: String(currentState.authMode || 'oauth').trim() || 'oauth',
      displayName: String(currentState.displayName || '').trim()
    };
    const runtimeState = {
      ...currentRuntimeState,
      cooldownUntil: blockedUntil,
      authInvalidUntil: blockedUntil,
      lastError: recoveryReason,
      lastFailureKind: 'auth_invalid',
      lastFailureReason: recoveryReason,
      lastFailureAt: now
    };

    let runtimeRecorded = false;
    let statusUpdated = false;
    try {
      runtimeRecorded = Boolean(
        accountStateService
        && typeof accountStateService.recordRuntimeFailure === 'function'
        && accountStateService.recordRuntimeFailure(accountRef, 'codex', runtimeState, baseState)
      );
    } catch (_error) {}
    try {
      statusUpdated = Boolean(
        accountStateService
        && typeof accountStateService.setOperationalStatus === 'function'
        && accountStateService.setOperationalStatus(accountRef, 'codex', 'down', baseState)
      );
    } catch (_error) {}

    return {
      action: runtimeRecorded || statusUpdated ? 'retained' : 'kept',
      accountRef,
      reason: normalizedReason,
      retained: runtimeRecorded || statusUpdated
    };
  }

  function clearRuntimeBlock(accountRef) {
    if (!accountStateService || typeof accountStateService.clearRuntimeBlock !== 'function') return false;
    return accountStateService.clearRuntimeBlock(accountRef, 'codex', {
      configured: true,
      apiKeyMode: false,
      evidence: 'token_refresh_success'
    });
  }

  async function refreshOrRetain(job) {
    const { authJson } = readAuthSnapshot(job.accountRef);
    if (!getRefreshToken(authJson)) {
      return retainAccount(job.accountRef, 'auth_invalid_missing_refresh_token');
    }

    const result = await refreshCodexAccessToken(
      buildRefreshAccount(job.accountRef, authJson),
      {
        force: true,
        timeoutMs: parseRefreshTimeoutMs(env),
        tokenUrl: String(env.AIH_CODEX_TOKEN_URL || DEFAULT_OPENAI_OAUTH_TOKEN_URL).trim(),
        proxyUrl: String(env.AIH_SERVER_PROXY_URL || '').trim(),
        noProxy: String(env.NO_PROXY || env.no_proxy || '').trim()
      },
      {
        fetchWithTimeout,
        accountArtifactHooks,
        fs,
        aiHomeDir
      }
    );

    if (job.cancelled) return { action: 'cancelled', accountRef: job.accountRef };
    if (result && result.ok) {
      clearRuntimeBlock(job.accountRef);
      return {
        action: 'refreshed',
        accountRef: job.accountRef,
        reason: String(result.reason || '').trim() || 'refreshed'
      };
    }
    if (isSessionInvalidRefreshFailure(result)) {
      return retainAccount(job.accountRef, String(result && result.reason || 'session_invalid'));
    }
    return {
      action: 'kept',
      accountRef: job.accountRef,
      reason: String(result && result.reason || 'refresh_failed').slice(0, 160)
    };
  }

  async function runJob(job) {
    if (job.cancelled) return { action: 'cancelled', accountRef: job.accountRef };
    if (job.kind === 'retain') return retainAccount(job.accountRef, job.reason);
    if (job.kind === 'refresh_or_retain') return refreshOrRetain(job);
    return { action: 'ignored', accountRef: job.accountRef };
  }

  function notifyIdleIfNeeded() {
    if (running > 0 || queue.length > 0) return;
    while (idleResolvers.length > 0) {
      const resolve = idleResolvers.shift();
      resolve();
    }
  }

  function drain() {
    scheduled = false;
    while (running < concurrency && queue.length > 0) {
      const job = queue.shift();
      running += 1;
      Promise.resolve()
        .then(() => runJob(job))
        .catch(() => null)
        .finally(() => {
          running -= 1;
          if (pendingByAccountRef.get(job.accountRef) === job) {
            pendingByAccountRef.delete(job.accountRef);
          }
          if (queue.length > 0) scheduleDrain();
          notifyIdleIfNeeded();
        });
    }
    notifyIdleIfNeeded();
  }

  function scheduleDrain() {
    if (scheduled) return;
    scheduled = true;
    schedule(drain);
  }

  function enqueueJob(job) {
    const accountRef = normalizeAccountRef(job && job.accountRef);
    if (!accountRef) return false;
    const nextJob = {
      ...job,
      accountRef,
      reason: String(job.reason || '').trim()
    };
    const current = pendingByAccountRef.get(accountRef);
    if (current) {
      if (current.kind === 'retain') return false;
      if (nextJob.kind !== 'retain') return false;
      current.cancelled = true;
    }
    pendingByAccountRef.set(accountRef, nextJob);
    queue.push(nextJob);
    scheduleDrain();
    return true;
  }

  function enqueueDirectHttpStatus401(provider, accountRef, reason = 'direct_http_status_401') {
    if (normalizeProvider(provider) !== 'codex') return false;
    return enqueueJob({
      kind: 'retain',
      accountRef,
      reason: isDirectHttpStatus401(reason) ? reason : `direct_http_status_401:${reason}`
    });
  }

  function enqueueAuthInvalidReauthRequired(provider, accountRef, reason = 'auth_invalid_reauth_required') {
    if (normalizeProvider(provider) !== 'codex') return false;
    if (!isAuthInvalidReauthRequired(reason)) return false;
    return enqueueJob({
      kind: 'refresh_or_retain',
      accountRef,
      reason
    });
  }

  function enqueueUsageProbeFailure(provider, accountRef, reason) {
    if (normalizeProvider(provider) !== 'codex') return false;
    if (isDirectHttpStatus401(reason)) {
      return enqueueDirectHttpStatus401(provider, accountRef, reason);
    }
    if (isAuthInvalidReauthRequired(reason)) {
      return enqueueAuthInvalidReauthRequired(provider, accountRef, reason);
    }
    return false;
  }

  function waitForIdle() {
    if (running === 0 && queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => idleResolvers.push(resolve));
  }

  function getQueueState() {
    return {
      queued: queue.length,
      running,
      pending: pendingByAccountRef.size
    };
  }

  return {
    enqueueUsageProbeFailure,
    enqueueDirectHttpStatus401,
    enqueueAuthInvalidReauthRequired,
    waitForIdle,
    getQueueState
  };
}

module.exports = {
  createCodexAuthInvalidReconciler,
  __private: {
    isDirectHttpStatus401,
    isAuthInvalidReauthRequired,
    isSessionInvalidRefreshFailure,
    buildRefreshAccount
  }
};
