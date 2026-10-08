'use strict';

const crypto = require('node:crypto');

const { readClaudeOauthCredential } = require('../account/claude-credential');
const { readAccountNativeAuth } = require('./account-credential-store');
const { isAccountRef } = require('./account-ref-store');
const {
  refreshClaudeAccessToken: defaultRefreshClaudeAccessToken
} = require('./claude-token-refresh');

const DEFAULT_RETRY_AFTER_MS = 5 * 60 * 1000;

function normalizeAccountRef(value) {
  const accountRef = String(value || '').trim();
  return isAccountRef(accountRef) ? accountRef : '';
}

function hashToken(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function isClaudeMessagesRecoveryCandidate(input = {}) {
  return String(input.entryId || '').trim() === 'gateway.anthropic.messages'
    && (Number(input.statusCode) === 401 || Number(input.statusCode) === 403);
}

/**
 * Go 只负责透传 Claude 的真实 401/403；Node 仍是 OAuth 刷新唯一所有者。
 * 每个账号在冷却窗口内只允许触发一次强制刷新，并按 access token 去重，避免普通
 * 权限 403 把 refresh token 端点打成循环；若它确实是 OAuth 被撤销，刷新成功后即可透明恢复。
 */
function createGoClaudeAuthRecovery(options = {}) {
  const fs = options.fs || require('node:fs');
  const aiHomeDir = String(options.aiHomeDir || '').trim();
  const readNativeAuth = typeof options.readAccountNativeAuth === 'function'
    ? options.readAccountNativeAuth
    : readAccountNativeAuth;
  const refreshClaudeAccessToken = typeof options.refreshClaudeAccessToken === 'function'
    ? options.refreshClaudeAccessToken
    : defaultRefreshClaudeAccessToken;
  const onCredentialUpdated = typeof options.onCredentialUpdated === 'function'
    ? options.onCredentialUpdated
    : async () => true;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const retryAfterMs = Math.max(
    30_000,
    Number(options.retryAfterMs) || DEFAULT_RETRY_AFTER_MS
  );
  const lastAttempts = new Map();
  const lastAccountAttempts = new Map();
  const inFlight = new Map();

  function readOAuth(accountRef) {
    if (!aiHomeDir || !accountRef) return null;
    try {
      const nativeAuth = readNativeAuth(fs, aiHomeDir, accountRef);
      const credential = readClaudeOauthCredential(nativeAuth, { nowMs: now() });
      if (!credential.accessToken || !credential.refreshToken) return null;
      return credential;
    } catch (_error) {
      return null;
    }
  }

  async function recover(input = {}) {
    if (!isClaudeMessagesRecoveryCandidate(input)) return false;
    const accountRef = normalizeAccountRef(input.accountRef);
    if (!accountRef) return false;
    const oauth = readOAuth(accountRef);
    if (!oauth) return false;

    const pending = inFlight.get(accountRef);
    if (pending) return pending;

    const tokenKey = `${accountRef}:${hashToken(oauth.accessToken)}`;
    const currentTime = Number(now()) || Date.now();
    const previousAttemptAt = Number(lastAttempts.get(tokenKey)) || 0;
    const previousAccountAttemptAt = Number(lastAccountAttempts.get(accountRef)) || 0;
    if ((previousAttemptAt > 0 && currentTime - previousAttemptAt < retryAfterMs)
      || (previousAccountAttemptAt > 0 && currentTime - previousAccountAttemptAt < retryAfterMs)) {
      return false;
    }

    lastAttempts.set(tokenKey, currentTime);
    lastAccountAttempts.set(accountRef, currentTime);
    const task = (async () => {
      const result = await refreshClaudeAccessToken(
        { provider: 'claude', accountRef },
        { force: true, nowMs: currentTime },
        options.refreshDeps || {}
      ).catch(() => null);
      if (!result || result.ok !== true || result.refreshed !== true || result.persisted === false) return false;
      try {
        return (await onCredentialUpdated({
          accountRef,
          reason: 'go_claude_403_recovery'
        })) !== false;
      } catch (_error) {
        return false;
      }
    })();
    inFlight.set(accountRef, task);
    try {
      return await task;
    } finally {
      if (inFlight.get(accountRef) === task) inFlight.delete(accountRef);
    }
  }

  return { recover };
}

module.exports = {
  createGoClaudeAuthRecovery,
  __private: {
    hashToken,
    isClaudeMessagesRecoveryCandidate,
    normalizeAccountRef
  }
};
