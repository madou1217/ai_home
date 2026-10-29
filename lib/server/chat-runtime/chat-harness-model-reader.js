'use strict';

const { discoverProviderModels, normalizeAccountScope } = require('../provider-model-discovery');
const {
  accountScopeNeverProbed,
  buildAccountsSignature,
  ensureWebUiModelsCacheLoaded,
  getWebUiModelsCache,
  WEBUI_MODELS_CACHE_TTL_MS
} = require('../webui-model-cache');
const { ChatRuntimeError } = require('./contracts');
const { createChatAccountModelPolicy } = require('./chat-account-model-policy');
const { isGatewayRuntimeScope } = require('../../account/runtime-target');

/** accountRef → provider：全局池分支要按「账号自己的 provider」查启用开关。 */
function accountProviderOf(state, accountRef) {
  const ref = String(accountRef || '').trim();
  if (!ref) return '';
  const accounts = state && state.accounts && typeof state.accounts === 'object' ? state.accounts : {};
  for (const [provider, list] of Object.entries(accounts)) {
    const found = (Array.isArray(list) ? list : [])
      .some((account) => String(account && account.accountRef || '') === ref);
    if (found) return String(provider || '').trim().toLowerCase();
  }
  return '';
}

function createChatHarnessModelReader({ getState, options = {}, ...deps }) {
  const isModelEnabled = createChatAccountModelPolicy(getState);
  let backgroundRefresh = null;
  return async function readModels(provider, accountRef) {
    const state = getState();
    // 网关作用域（aih-server）：目录是**全局池** —— 该模型只要有任一账号探测到且启用就出现，
    // provider 由网关按模型 id 解析，所以会话内可以跨 provider 换模型。
    if (isGatewayRuntimeScope(accountRef)) {
      // The gateway catalog is global, but its persisted snapshot can survive a
      // Codex CLI upgrade and otherwise hide models exposed only by later
      // accounts. Refresh when the snapshot is stale or its account/version
      // signature no longer matches; probe every Codex account in that refresh.
      const cacheDeps = { ...deps };
      const cache = ensureWebUiModelsCacheLoaded(state, cacheDeps);
      const codexClientVersion = typeof options.currentCodexClientVersion === 'function'
        ? options.currentCodexClientVersion()
        : options.codexClientVersion;
      const expectedSignature = buildAccountsSignature(state, 0, null, {
        ...cacheDeps,
        codexClientVersion
      });
      const stale = !cache.updatedAt
        || Date.now() - cache.updatedAt >= WEBUI_MODELS_CACHE_TTL_MS
        || cache.signature !== expectedSignature;
      const refreshOptions = {
        ...cacheDeps,
        accountLimit: 0,
        probeCodex: true,
        forceRefresh: stale,
        timeoutMs: 8000
      };
      // Keep the last known catalog immediately usable while a stale snapshot
      // is refreshed. An empty snapshot must still wait for its first probe.
      const hasSnapshot = Object.values(cache.byAccount || {}).some((models) => Array.isArray(models) && models.length > 0);
      let result = { byAccount: cache.byAccount };
      if (stale && hasSnapshot) {
        if (!backgroundRefresh) {
          backgroundRefresh = getWebUiModelsCache(state, options, refreshOptions)
            .catch(() => {})
            .finally(() => { backgroundRefresh = null; });
        }
      } else if (stale) {
        result = await getWebUiModelsCache(state, options, refreshOptions);
      }
      const ids = new Set();
      Object.entries(result.byAccount || {}).forEach(([ref, models]) => {
        const provider = accountProviderOf(state, ref);
        (Array.isArray(models) ? models : []).forEach((model) => {
          if (provider && isModelEnabled(provider, ref, model)) ids.add(model);
        });
      });
      return [...ids];
    }
    const accountScope = normalizeAccountScope({ accountRef });
    const accounts = state.accounts && state.accounts[provider];
    if (!accountScope || !Array.isArray(accounts)
      || !accounts.some((account) => account.accountRef === accountScope.accountRef)) {
      throw new ChatRuntimeError('chat_session_account_mismatch', 409);
    }
    // 复用 WebUI 的持久缓存、账号首探和失败退避，避免 Chat 等待后台调度器。
    await getWebUiModelsCache(state, options, {
      ...deps,
      accountScope,
      forceRefresh: accountScopeNeverProbed(state, deps, accountScope),
      timeoutMs: 8000
    });
    const result = await discoverProviderModels({
      state, options, providerMode: provider, includeCodex: true,
      includeRegistry: false, includeAccountModels: true,
      accountScope
    });
    return (result.byAccount[accountScope.accountRef] || [])
      .filter((model) => isModelEnabled(provider, accountScope.accountRef, model));
  };
}

module.exports = { createChatHarnessModelReader };
