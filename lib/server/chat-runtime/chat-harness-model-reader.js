'use strict';

const { discoverProviderModels, normalizeAccountScope } = require('../provider-model-discovery');
const { accountScopeNeverProbed, getWebUiModelsCache } = require('../webui-model-cache');
const { ChatRuntimeError } = require('./contracts');
const { createChatAccountModelPolicy } = require('./chat-account-model-policy');
const { isGatewayRuntimeScope } = require('../../account/runtime-target');

function createChatHarnessModelReader({ getState, options = {}, ...deps }) {
  const isModelEnabled = createChatAccountModelPolicy(getState);
  return async function readModels(provider, accountRef) {
    const state = getState();
    // 网关作用域（aih-server）：目录是**该 provider 全池的并集** —— 任一账号探测到且启用
    // 就出现在列表里，由网关按 (账号,模型) 可用性、熔断与别名在池内挑号。
    if (isGatewayRuntimeScope(accountRef)) {
      const accounts = state.accounts && state.accounts[provider];
      if (!Array.isArray(accounts) || accounts.length === 0) {
        throw new ChatRuntimeError('chat_session_account_mismatch', 409);
      }
      await getWebUiModelsCache(state, options, { ...deps, timeoutMs: 8000 });
      const result = await discoverProviderModels({
        state, options, providerMode: provider, includeCodex: true,
        includeRegistry: false, includeAccountModels: true
      });
      const ids = new Set();
      Object.entries(result.byAccount || {}).forEach(([ref, models]) => {
        (Array.isArray(models) ? models : []).forEach((model) => {
          if (isModelEnabled(provider, ref, model)) ids.add(model);
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
