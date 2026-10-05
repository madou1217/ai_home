'use strict';

const { refreshCodexAccessToken } = require('./codex-token-refresh');
const { refreshGeminiAccessToken } = require('./gemini-token-refresh');
const { refreshClaudeAccessToken } = require('./claude-token-refresh');
const { refreshAgyAccessToken } = require('./agy-token-refresh');
const { refreshGrokAccessToken } = require('./grok-token-refresh');
const { refreshKimiAccessToken } = require('./kimi-token-refresh');
const { deriveAccountRuntimeStatus } = require('./account-runtime-state');

function isApiKeyRuntimeAccount(account) {
  return Boolean(
    account
    && (
      account.apiKeyMode
      || String(account.authType || '').trim().toLowerCase() === 'api-key'
    )
  );
}

/**
 * 后台令牌刷新的 provider 策略表（顺序即每轮刷新的派发顺序）。没有列出的 provider
 * （zcode、CodeBuddy 家族、opencode 等）不由守护进程刷新。
 *
 * - refresh(account, options, deps): 该 provider 的刷新实现
 * - forceRefresh(account)?: 返回 true 时本次强制刷新（不等临近过期）
 * - handlesInvalidSuppression?: 由实现自己判断是否跳过「已判失效」的账号（守护进程不预先拦截）
 * - extraDeps(context)?: 该实现额外需要的依赖
 */
const TOKEN_REFRESH_STRATEGIES = Object.freeze([
  { id: 'codex', refresh: refreshCodexAccessToken },
  { id: 'gemini', refresh: refreshGeminiAccessToken },
  { id: 'claude', refresh: refreshClaudeAccessToken },
  { id: 'agy', refresh: refreshAgyAccessToken },
  {
    id: 'grok',
    refresh: refreshGrokAccessToken,
    // grok OAuth 账号一旦判为 auth_invalid，立即强制刷新尝试自愈。
    forceRefresh: (account, nowMs = Date.now()) => !isApiKeyRuntimeAccount(account)
      && deriveAccountRuntimeStatus(account, nowMs).status === 'auth_invalid'
  },
  {
    id: 'kimi',
    refresh: refreshKimiAccessToken,
    // Kimi 必须先与 CLI 轮换过的凭据对账，再比较被拒的授权签名；守护进程预先拦截会挡住本地恢复。
    handlesInvalidSuppression: true,
    extraDeps: ({ hostHomeDir, reconcileKimiHostCredentials, shouldSuppressInvalidRefresh }) => ({
      hostHomeDir,
      reconcileHostCredentials: reconcileKimiHostCredentials,
      shouldSkipRefresh: shouldSuppressInvalidRefresh
    })
  }
].map((strategy) => Object.freeze(strategy)));

module.exports = { TOKEN_REFRESH_STRATEGIES, isApiKeyRuntimeAccount };
