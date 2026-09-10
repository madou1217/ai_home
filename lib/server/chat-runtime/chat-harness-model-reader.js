'use strict';

const { discoverProviderModels, normalizeAccountScope } = require('../provider-model-discovery');
const { accountScopeNeverProbed, getWebUiModelsCache } = require('../webui-model-cache');
const { ChatRuntimeError } = require('./contracts');

function createChatHarnessModelReader({ getState, options = {}, ...deps }) {
  return async function readModels(provider, accountRef) {
    const state = getState();
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
    return result.byAccount[accountScope.accountRef] || [];
  };
}

module.exports = { createChatHarnessModelReader };
