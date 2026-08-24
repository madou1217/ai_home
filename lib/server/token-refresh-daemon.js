'use strict';

const crypto = require('node:crypto');

const { refreshCodexAccessToken } = require('./codex-token-refresh');
const { refreshGeminiAccessToken } = require('./gemini-token-refresh');
const { refreshClaudeAccessToken } = require('./claude-token-refresh');
const { refreshAgyAccessToken } = require('./agy-token-refresh');
const { refreshGrokAccessToken } = require('./grok-token-refresh');
const { refreshKimiAccessToken } = require('./kimi-token-refresh');
const { buildAuthInvalidRuntimeState } = require('../account/runtime-state-builders');
const { deriveAccountRuntimeStatus } = require('./account-runtime-state');
const { ACCOUNT_RUNTIME_CHANGED } = require('./account-runtime-event-types');
const { isUnrecoverableTokenRefreshFailure } = require('./token-refresh-result');

const DEFAULT_REFRESH_INTERVAL_MS = 10 * 60 * 1000; // 每 10 分钟检查一次
const DEFAULT_REFRESH_BEFORE_EXPIRY_MS = 30 * 60 * 1000; // 提前 30 分钟刷新
const DEFAULT_STARTUP_REFRESH_BEFORE_EXPIRY_MS = 5 * 60 * 1000; // 启动时提前 5 分钟刷新
const INVALID_REFRESH_RETRY_DELAY_MS = 24 * 60 * 60 * 1000;

function isApiKeyRuntimeAccount(account) {
  return Boolean(
    account
    && (
      account.apiKeyMode
      || String(account.authType || '').trim().toLowerCase() === 'api-key'
    )
  );
}

// Refresh token 被拒绝只证明 refresh 这条路径失效，不能反推出当前 access
// token 已失效。这里不使用本地 expiresAt 推断认证失效：该字段可能是旧快照，
// 最终的 auth_invalid 必须由真实上游 401 或明确缺失 access token 的证据触发。
function hasAccessToken(account) {
  const accessToken = String(account && account.accessToken || '').trim();
  return Boolean(accessToken);
}

function shouldForceGrokAuthRecovery(account, provider, nowMs = Date.now()) {
  if (String(provider || '').trim().toLowerCase() !== 'grok') return false;
  if (isApiKeyRuntimeAccount(account)) return false;
  return deriveAccountRuntimeStatus(account, nowMs).status === 'auth_invalid';
}

function createTokenRefreshDaemon(state, options, deps) {
  const {
    fetchWithTimeout,
    fs,
    aiHomeDir,
    hostHomeDir,
    reconcileKimiHostCredentials,
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
  // 只保存 refresh token 的不可逆摘要和下一次重试时间，不保存 token 本身。
  // 这样运行池每次重载生成新账号对象后，仍不会重复撞击已确认失效的 grant；
  // 新登录产生不同 refresh token 时，摘要变化会自动解除抑制。
  const invalidRefreshRetryByAccount = new Map();

  function hashRefreshToken(account) {
    const refreshToken = String(account && account.refreshToken || '').trim();
    if (!refreshToken) return '';
    return `${refreshToken.length}:${crypto.createHash('sha256').update(refreshToken).digest('hex')}`;
  }

  function shouldSuppressInvalidRefresh(account, nowMs = Date.now()) {
    const accountRef = String(account && account.accountRef || '').trim();
    if (!accountRef) return false;
    const entry = invalidRefreshRetryByAccount.get(accountRef);
    if (!entry) return false;
    const signature = hashRefreshToken(account);
    if (entry.signature !== signature || entry.retryAt <= nowMs) {
      invalidRefreshRetryByAccount.delete(accountRef);
      return false;
    }
    return true;
  }

  function rememberInvalidRefresh(account, nowMs = Date.now()) {
    const accountRef = String(account && account.accountRef || '').trim();
    if (!accountRef) return;
    invalidRefreshRetryByAccount.set(accountRef, {
      signature: hashRefreshToken(account),
      retryAt: nowMs + INVALID_REFRESH_RETRY_DELAY_MS
    });
  }

  // Demote an account whose refresh token is dead to auth_invalid. Mirrors the
  // success path (which clears the block): emit ACCOUNT_RUNTIME_CHANGED with a
  // non-null runtimeState so the registered listeners persist it to the DB and
  // apply it to the in-memory account — that flips management/accounts from a
  // false "healthy" to auth_invalid and makes shouldProbeAccountModels skip it,
  // killing the recurring probe-401 noise. Idempotent: skips if already blocked.
  function markAccountAuthInvalid(account, provider, accountRef, reason) {
    // API-key accounts don't use token refresh — they authenticate by key, have no
    // refresh token, and never hit the token endpoint. A refresh "failure" for them
    // (most commonly `missing_refresh_token`) is expected and meaningless, so the
    // token-refresh daemon must NEVER demote them: doing so would block a fully
    // working api-key account. OAuth-only.
    if (isApiKeyRuntimeAccount(account)) {
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
        accountRef,
        nextStatus: 'auth_invalid',
        source: 'token_refresh',
        runtimeState,
        baseState,
        reloadPool: false,
        reason
      });
    }
    if (typeof logWarn === 'function') {
      logWarn(`Marked ${provider}#${accountRef} auth_invalid (re-login required): ${reason}`);
    }
    return true;
  }

  async function refreshAccountToken(account, provider, isStartup = false) {
    const accountRef = String(account.accountRef || '').trim();
    if (!accountRef) return;
    const effectiveSkewMs = isStartup ? startupSkewMs : skewMs;
    if (isApiKeyRuntimeAccount(account)) return;
    if (shouldSuppressInvalidRefresh(account)) return;

    try {
      let result = null;

      if (provider === 'codex') {
        result = await refreshCodexAccessToken(account, {
          force: false,
          skewMs: effectiveSkewMs,
          timeoutMs: options.upstreamTimeoutMs,
          proxyUrl: options.proxyUrl,
          noProxy: options.noProxy
        }, { fetchWithTimeout, accountArtifactHooks, fs, aiHomeDir });
      } else if (provider === 'gemini') {
        result = await refreshGeminiAccessToken(account, {
          force: false,
          skewMs: effectiveSkewMs,
          timeoutMs: options.upstreamTimeoutMs,
          proxyUrl: options.proxyUrl,
          noProxy: options.noProxy
        }, { fetchWithTimeout, accountArtifactHooks, fs, aiHomeDir });
      } else if (provider === 'claude') {
        result = await refreshClaudeAccessToken(account, {
          force: false,
          skewMs: effectiveSkewMs,
          timeoutMs: options.upstreamTimeoutMs,
          proxyUrl: options.proxyUrl,
          noProxy: options.noProxy
        }, { fetchWithTimeout, accountArtifactHooks, fs, aiHomeDir });
      } else if (provider === 'agy') {
        result = await refreshAgyAccessToken(account, {
          force: false,
          skewMs: effectiveSkewMs,
          timeoutMs: options.upstreamTimeoutMs,
          proxyUrl: options.proxyUrl,
          noProxy: options.noProxy
        }, { fetchWithTimeout, accountArtifactHooks, fs, aiHomeDir });
      } else if (provider === 'grok') {
        result = await refreshGrokAccessToken(account, {
          force: shouldForceGrokAuthRecovery(account, provider),
          skewMs: effectiveSkewMs,
          timeoutMs: options.upstreamTimeoutMs,
          proxyUrl: options.proxyUrl,
          noProxy: options.noProxy
        }, { fetchWithTimeout, accountArtifactHooks, fs, aiHomeDir });
      } else if (provider === 'kimi') {
        result = await refreshKimiAccessToken(account, {
          force: false,
          skewMs: effectiveSkewMs,
          timeoutMs: options.upstreamTimeoutMs,
          proxyUrl: options.proxyUrl,
          noProxy: options.noProxy
        }, {
          fetchWithTimeout,
          accountArtifactHooks,
          fs,
          aiHomeDir,
          hostHomeDir,
          reconcileHostCredentials: reconcileKimiHostCredentials
        });
      }

      if (!result) return;

      if (!result.ok) {
        totalErrors += 1;
        if (typeof logWarn === 'function') {
          logWarn(`Token refresh failed for ${provider}#${accountRef}: ${result.reason} ${result.detail || ''}`);
        }
        if (isUnrecoverableTokenRefreshFailure(result) && !hasAccessToken(account)) {
          markAccountAuthInvalid(account, provider, accountRef, `token_refresh_${result.reason}`);
        } else if (isUnrecoverableTokenRefreshFailure(result)) {
          rememberInvalidRefresh(account);
          if (typeof logInfo === 'function') {
            logInfo(
              `Refresh token rejected for ${provider}#${accountRef}; `
              + 'current access token remains usable, waiting for a real auth failure'
            );
          }
        }
        return;
      }

      if (result.refreshed) {
        totalRefreshed += 1;
        if (typeof logInfo === 'function') {
          const expiryInfo = result.expiresAt
            ? ` (expires: ${new Date(result.expiresAt).toISOString()})`
            : '';
          logInfo(`Token refreshed for ${provider}#${accountRef}${expiryInfo} persisted=${result.persisted}`);
        }

        // Clear the auth_invalid runtime block in the database and memory!
        if (accountStateService && typeof accountStateService.clearRuntimeBlock === 'function') {
          try {
            const baseState = {
              configured: true,
              apiKeyMode: Boolean(account.apiKeyMode || account.authType === 'api-key'),
              authMode: String(account.authType || '').trim(),
              displayName: String(account.email || account.displayName || '').trim()
            };

            const cleared = await accountStateService.clearRuntimeBlock(accountRef, provider, {
              ...baseState,
              evidence: 'token_refresh_success'
            });
            if (!cleared) return;

            account.authInvalidUntil = 0;
            account.consecutiveFailures = 0;
            account.lastError = '';

            // Notify server pool to reload/sync (canonical event constant).
            if (hub && typeof hub.emit === 'function') {
              hub.emit(ACCOUNT_RUNTIME_CHANGED, {
                provider,
                accountRef,
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
              logWarn(`Failed to clear runtime block after refresh for ${provider}#${accountRef}: ${err.message}`);
            }
          }
        }
      }
    } catch (error) {
      totalErrors += 1;
      if (typeof logError === 'function') {
        logError(`Token refresh exception for ${provider}#${accountRef}: ${error.message || error}`);
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
    const grokAccounts = state.accounts.grok || [];
    const kimiAccounts = state.accounts.kimi || [];

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

    for (const account of grokAccounts) {
      tasks.push(refreshAccountToken(account, 'grok', isStartup));
    }

    for (const account of kimiAccounts) {
      tasks.push(refreshAccountToken(account, 'kimi', isStartup));
    }

    await Promise.allSettled(tasks);

    const durationMs = Date.now() - startTime;

    if (typeof logInfo === 'function') {
      const totalAccounts = codexAccounts.length + geminiAccounts.length + claudeAccounts.length + agyAccounts.length + grokAccounts.length + kimiAccounts.length;
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
    isUnrecoverableAuthFailure: isUnrecoverableTokenRefreshFailure,
    shouldForceGrokAuthRecovery
  }
};
