'use strict';

const { refreshCodexAccessToken } = require('./codex-token-refresh');
const { refreshGeminiAccessToken } = require('./gemini-token-refresh');
const { refreshClaudeAccessToken } = require('./claude-token-refresh');
const { refreshAgyAccessToken } = require('./agy-token-refresh');
const { buildAuthInvalidRuntimeState } = require('../account/runtime-state-builders');
const { ACCOUNT_RUNTIME_CHANGED } = require('./account-runtime-event-types');

const DEFAULT_REFRESH_INTERVAL_MS = 10 * 60 * 1000; // 每 10 分钟检查一次
const DEFAULT_REFRESH_BEFORE_EXPIRY_MS = 30 * 60 * 1000; // 提前 30 分钟刷新
const DEFAULT_STARTUP_REFRESH_BEFORE_EXPIRY_MS = 5 * 60 * 1000; // 启动时提前 5 分钟刷新

// A refresh failure is "unrecoverable" when the refresh token itself is rejected
// (revoked/expired grant, or absent) — retrying can never mint a valid token, the
// account must be re-logged-in. All provider refreshers report this the same way:
// an HTTP 400/401/403 from the token endpoint (reason `refresh_http_<status>` +
// numeric `status`), a `missing_refresh_token` reason, or an `invalid_grant` detail.
// Transient failures (network/5xx/timeout → `refresh_exception`) are NOT included,
// so a flaky network never demotes a healthy account.
function isUnrecoverableAuthFailure(result) {
  if (!result || result.ok) return false;
  const status = Number(result.status);
  if (status === 400 || status === 401 || status === 403) return true;
  if (String(result.reason || '') === 'missing_refresh_token') return true;
  if (/invalid_grant/i.test(String(result.detail || ''))) return true;
  return false;
}

function createTokenRefreshDaemon(state, options, deps) {
  const {
    fetchWithTimeout,
    accountArtifactHooks,
    accountStateService,
    hub,
    reloadRuntimePool,
    logInfo,
    logWarn,
    logError
  } = deps;

  const refreshIntervalMs = Math.max(
    60_000,
    Number(options.tokenRefreshIntervalMs) || DEFAULT_REFRESH_INTERVAL_MS
  );

  const skewMs = Math.max(
    60_000,
    Number(options.tokenRefreshBeforeExpiryMs) || DEFAULT_REFRESH_BEFORE_EXPIRY_MS
  );

  const startupSkewMs = Math.max(
    30_000,
    Number(options.tokenStartupRefreshBeforeExpiryMs) || DEFAULT_STARTUP_REFRESH_BEFORE_EXPIRY_MS
  );

  let tickCount = 0;
  let lastTickAt = 0;
  let totalRefreshed = 0;
  let totalErrors = 0;
  let totalAuthInvalid = 0;

  // Demote an account whose refresh token is dead to auth_invalid. Mirrors the
  // success path (which clears the block): emit ACCOUNT_RUNTIME_CHANGED with a
  // non-null runtimeState so the registered listeners persist it to the DB and
  // apply it to the in-memory account — that flips management/accounts from a
  // false "healthy" to auth_invalid and makes shouldProbeAccountModels skip it,
  // killing the recurring probe-401 noise. Idempotent: skips if already blocked.
  function markAccountAuthInvalid(account, provider, accountId, reason) {
    // API-key accounts don't use token refresh — they authenticate by key, have no
    // refresh token, and never hit the token endpoint. A refresh "failure" for them
    // (most commonly `missing_refresh_token`) is expected and meaningless, so the
    // token-refresh daemon must NEVER demote them: doing so would block a fully
    // working api-key account. OAuth-only.
    if (account.apiKeyMode || String(account.authType || '').trim().toLowerCase() === 'api-key') {
      return false;
    }
    const nowMs = Date.now();
    if (Number(account.authInvalidUntil) > nowMs) return false;

    const runtimeState = buildAuthInvalidRuntimeState(reason, { nowMs });
    // Reflect in memory immediately (and as a fallback when no hub is wired),
    // so status + probe-skip are correct even before listeners run.
    account.authInvalidUntil = runtimeState.authInvalidUntil;
    account.cooldownUntil = Math.max(Number(account.cooldownUntil) || 0, runtimeState.cooldownUntil);
    account.consecutiveFailures = (Number(account.consecutiveFailures) || 0) + 1;
    account.lastFailureKind = 'auth_invalid';
    account.lastFailureReason = reason;
    account.lastError = reason;
    totalAuthInvalid += 1;

    const baseState = {
      configured: true,
      apiKeyMode: Boolean(account.apiKeyMode || account.authType === 'api-key'),
      authMode: String(account.authType || '').trim(),
      displayName: String(account.email || account.displayName || '').trim()
    };

    // Emit the canonical event so the registered listeners persist the block to
    // the DB (recordRuntimeFailure) AND apply it to the in-memory account +
    // invalidate the model cache. NOTE: must use the ACCOUNT_RUNTIME_CHANGED
    // constant ('account.runtime.changed'), NOT the literal string — the listener
    // subscribes by the constant, so a literal silently reaches no one.
    if (hub && typeof hub.emit === 'function') {
      hub.emit(ACCOUNT_RUNTIME_CHANGED, {
        provider,
        accountId,
        nextStatus: 'auth_invalid',
        source: 'token_refresh',
        runtimeState,
        baseState,
        reloadPool: false,
        reason
      });
    }
    if (typeof logWarn === 'function') {
      logWarn(`Marked ${provider}#${accountId} auth_invalid (re-login required): ${reason}`);
    }
    return true;
  }

  async function refreshAccountToken(account, provider, isStartup = false) {
    const accountId = String(account.id || 'unknown');
    const effectiveSkewMs = isStartup ? startupSkewMs : skewMs;

    try {
      let result = null;

      if (provider === 'codex') {
        result = await refreshCodexAccessToken(account, {
          force: false,
          skewMs: effectiveSkewMs,
          timeoutMs: options.upstreamTimeoutMs,
          proxyUrl: options.proxyUrl,
          noProxy: options.noProxy
        }, { fetchWithTimeout, accountArtifactHooks });
      } else if (provider === 'gemini') {
        result = await refreshGeminiAccessToken(account, {
          force: false,
          skewMs: effectiveSkewMs,
          timeoutMs: options.upstreamTimeoutMs,
          proxyUrl: options.proxyUrl,
          noProxy: options.noProxy
        }, { fetchWithTimeout, accountArtifactHooks });
      } else if (provider === 'claude') {
        result = await refreshClaudeAccessToken(account, {
          force: false,
          skewMs: effectiveSkewMs,
          timeoutMs: options.upstreamTimeoutMs,
          proxyUrl: options.proxyUrl,
          noProxy: options.noProxy
        }, { fetchWithTimeout, accountArtifactHooks });
      } else if (provider === 'agy') {
        result = await refreshAgyAccessToken(account, {
          force: false,
          skewMs: effectiveSkewMs,
          timeoutMs: options.upstreamTimeoutMs,
          proxyUrl: options.proxyUrl,
          noProxy: options.noProxy
        }, { fetchWithTimeout, accountArtifactHooks });
      }

      if (!result) return;

      if (!result.ok) {
        totalErrors += 1;
        if (typeof logWarn === 'function') {
          logWarn(`Token refresh failed for ${provider}#${accountId}: ${result.reason} ${result.detail || ''}`);
        }
        if (isUnrecoverableAuthFailure(result)) {
          markAccountAuthInvalid(account, provider, accountId, `token_refresh_${result.reason}`);
        }
        return;
      }

      if (result.refreshed) {
        totalRefreshed += 1;
        if (typeof logInfo === 'function') {
          const expiryInfo = result.expiresAt
            ? ` (expires: ${new Date(result.expiresAt).toISOString()})`
            : '';
          logInfo(`Token refreshed for ${provider}#${accountId}${expiryInfo} persisted=${result.persisted}`);
        }

        // Clear the auth_invalid runtime block in the database and memory!
        if (accountStateService && typeof accountStateService.clearRuntimeBlock === 'function') {
          try {
            account.authInvalidUntil = 0;
            account.consecutiveFailures = 0;
            account.lastError = '';

            const baseState = {
              configured: true,
              apiKeyMode: Boolean(account.apiKeyMode || account.authType === 'api-key'),
              authMode: String(account.authType || '').trim(),
              displayName: String(account.email || account.displayName || '').trim()
            };

            await accountStateService.clearRuntimeBlock(provider, accountId, {
              ...baseState,
              evidence: 'token_refresh_success'
            });

            // Notify server pool to reload/sync (canonical event constant).
            if (hub && typeof hub.emit === 'function') {
              hub.emit(ACCOUNT_RUNTIME_CHANGED, {
                provider,
                accountId,
                nextStatus: 'healthy',
                source: 'token_refresh',
                runtimeState: null,
                baseState,
                reloadPool: true,
                reason: 'token_refresh_success'
              });
            }
          } catch (err) {
            if (typeof logWarn === 'function') {
              logWarn(`Failed to clear runtime block after refresh for ${provider}#${accountId}: ${err.message}`);
            }
          }
        }
      }
    } catch (error) {
      totalErrors += 1;
      if (typeof logError === 'function') {
        logError(`Token refresh exception for ${provider}#${accountId}: ${error.message || error}`);
      }
    }
  }

  async function tick(isStartup = false) {
    const nowMs = Date.now();
    lastTickAt = nowMs;
    tickCount += 1;

    const tickType = isStartup ? 'startup' : 'periodic';
    const startTime = Date.now();

    if (typeof logInfo === 'function' && !isStartup) {
      logInfo(`Token refresh daemon tick #${tickCount} (${tickType})`);
    }

    // 先重载运行池，再刷新。OAuth token 文件可能在上次加载后才写入/刷新（agy 原生 CLI 登录、
    // 后台刷新等）；若不重载，这些账号一直不在 state.accounts 里 → 永远不会被下面的刷新覆盖 →
    // 卡在 blocked_by_policy(agy_access_token_required) 直到【手动客户端刷新】才恢复。每 tick
    // 重载一次让其自愈：账号重新进池 → 本轮即可被刷新到，token 过期前续上、过期了也能补刷。
    if (typeof reloadRuntimePool === 'function') {
      try {
        reloadRuntimePool();
      } catch (error) {
        if (typeof logWarn === 'function') {
          logWarn(`Runtime pool reload failed before refresh tick #${tickCount}: ${error.message || error}`);
        }
      }
    }

    const codexAccounts = state.accounts.codex || [];
    const geminiAccounts = state.accounts.gemini || [];
    const claudeAccounts = state.accounts.claude || [];
    const agyAccounts = state.accounts.agy || [];

    const tasks = [];

    for (const account of codexAccounts) {
      tasks.push(refreshAccountToken(account, 'codex', isStartup));
    }

    for (const account of geminiAccounts) {
      tasks.push(refreshAccountToken(account, 'gemini', isStartup));
    }

    for (const account of claudeAccounts) {
      tasks.push(refreshAccountToken(account, 'claude', isStartup));
    }

    for (const account of agyAccounts) {
      tasks.push(refreshAccountToken(account, 'agy', isStartup));
    }

    await Promise.allSettled(tasks);

    const durationMs = Date.now() - startTime;

    if (typeof logInfo === 'function') {
      const totalAccounts = codexAccounts.length + geminiAccounts.length + claudeAccounts.length + agyAccounts.length;
      logInfo(
        `Token refresh daemon tick #${tickCount} completed in ${durationMs}ms ` +
        `(accounts: ${totalAccounts}, refreshed: ${totalRefreshed}, errors: ${totalErrors})`
      );
    }
  }

  // 启动时立即刷新一次
  tick(true).catch((error) => {
    if (typeof logError === 'function') {
      logError(`Token refresh daemon startup tick failed: ${error.message || error}`);
    }
  });

  // 定期刷新
  const timer = setInterval(() => {
    tick(false).catch((error) => {
      if (typeof logError === 'function') {
        logError(`Token refresh daemon periodic tick failed: ${error.message || error}`);
      }
    });
  }, refreshIntervalMs);

  // 不阻止进程退出
  timer.unref();

  return {
    stop: () => {
      clearInterval(timer);
      if (typeof logInfo === 'function') {
        logInfo('Token refresh daemon stopped');
      }
    },
    getStats: () => ({
      tickCount,
      lastTickAt,
      totalRefreshed,
      totalErrors,
      totalAuthInvalid,
      refreshIntervalMs,
      skewMs
    }),
    forceRefresh: () => tick(false)
  };
}

module.exports = {
  createTokenRefreshDaemon,
  __private: {
    isUnrecoverableAuthFailure
  }
};
