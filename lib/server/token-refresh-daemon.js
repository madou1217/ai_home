'use strict';

const { refreshCodexAccessToken } = require('./codex-token-refresh');
const { refreshGeminiAccessToken } = require('./gemini-token-refresh');
const { refreshClaudeAccessToken } = require('./claude-token-refresh');

const DEFAULT_REFRESH_INTERVAL_MS = 10 * 60 * 1000; // 每 10 分钟检查一次
const DEFAULT_REFRESH_BEFORE_EXPIRY_MS = 30 * 60 * 1000; // 提前 30 分钟刷新
const DEFAULT_STARTUP_REFRESH_BEFORE_EXPIRY_MS = 5 * 60 * 1000; // 启动时提前 5 分钟刷新

function createTokenRefreshDaemon(state, options, deps) {
  const {
    fetchWithTimeout,
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
        }, { fetchWithTimeout });
      } else if (provider === 'gemini') {
        result = await refreshGeminiAccessToken(account, {
          force: false,
          skewMs: effectiveSkewMs,
          timeoutMs: options.upstreamTimeoutMs,
          proxyUrl: options.proxyUrl,
          noProxy: options.noProxy
        }, { fetchWithTimeout });
      } else if (provider === 'claude') {
        result = await refreshClaudeAccessToken(account, {
          force: false,
          skewMs: effectiveSkewMs,
          timeoutMs: options.upstreamTimeoutMs,
          proxyUrl: options.proxyUrl,
          noProxy: options.noProxy
        }, { fetchWithTimeout });
      }

      if (!result) return;

      if (!result.ok) {
        totalErrors += 1;
        if (typeof logWarn === 'function') {
          logWarn(`Token refresh failed for ${provider}#${accountId}: ${result.reason} ${result.detail || ''}`);
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

    const codexAccounts = state.accounts.codex || [];
    const geminiAccounts = state.accounts.gemini || [];
    const claudeAccounts = state.accounts.claude || [];

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

    await Promise.allSettled(tasks);

    const durationMs = Date.now() - startTime;

    if (typeof logInfo === 'function') {
      const totalAccounts = codexAccounts.length + geminiAccounts.length + claudeAccounts.length;
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
      refreshIntervalMs,
      skewMs
    }),
    forceRefresh: () => tick(false)
  };
}

module.exports = {
  createTokenRefreshDaemon
};
