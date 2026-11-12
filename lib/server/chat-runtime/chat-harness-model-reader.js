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
const { createChatHarnessGoModelSource } = require('./chat-harness-go-models');
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

function createChatHarnessModelReader({
  getState,
  options = {},
  // 仅网关分支使用：Go account_models 的读取口与 Go ref → Node ref 的翻译。
  // 它们不进入下面的 `deps`，本地快照/探测链拿到的参数保持原样。
  readGoAccountModels,
  nodeAccountRefFor,
  ...deps
}) {
  const isModelEnabled = createChatAccountModelPolicy(getState);
  const goModelSource = createChatHarnessGoModelSource({
    readAccountModels: readGoAccountModels,
    nodeAccountRefFor
  });
  let backgroundRefresh = null;

  // 网关目录是全局池：模型只在该账号自己的 provider 开关允许时出现。
  // 快照与 Go 两个来源共用这一段，避免两条路径的过滤语义漂移。
  function collectGatewayModelIds(state, byAccount, providerByAccount) {
    const ids = new Set();
    Object.entries(byAccount || {}).forEach(([ref, models]) => {
      // Go 独有账号不在 Node 运行池里：provider 取 Go 行自己的声明，
      // 否则会被当成未知 Provider 整块跳过，聊天目录与账号页不一致。
      const provider = accountProviderOf(state, ref)
        || String((providerByAccount && providerByAccount[ref]) || '').trim().toLowerCase();
      (Array.isArray(models) ? models : []).forEach((model) => {
        if (provider && isModelEnabled(provider, ref, model)) ids.add(model);
      });
    });
    return [...ids];
  }

  return async function readModels(provider, accountRef) {
    const state = getState();
    // 网关作用域（aih-server）：目录是**全局池** —— 该模型只要有任一账号探测到且启用就出现，
    // provider 由网关按模型 id 解析，所以会话内可以跨 provider 换模型。
    if (isGatewayRuntimeScope(accountRef)) {
      // 网关目录先读 Go 的 account_models（只取 effective）。Go 不可用、超时或
      // 没有任何 effective 集合时返回 null，继续走下面的本地快照路径——不能把
      // 「读不到」当成「没有模型」，否则 composer 的目录会被清空。
      const goCatalog = await goModelSource();
      const cacheDeps = { ...deps };
      const cache = ensureWebUiModelsCacheLoaded(state, cacheDeps);
      // 目录是 Go effective 行与 Node 快照的并集：账号页就是两份来源合并展示，
      // 只取 Go 会让 Node 独有账号（如 claude）的模型从聊天里消失；只取快照又会
      // 丢掉 Go 独有账号。两边都按各自 provider/账号开关过滤后再合并。
      const ids = new Set();
      if (goCatalog) {
        collectGatewayModelIds(
          state,
          goCatalog.byAccount,
          goCatalog.providerByAccount
        ).forEach((id) => ids.add(id));
      }
      collectGatewayModelIds(state, cache.byAccount).forEach((id) => ids.add(id));
      if (ids.size > 0) return [...ids];
      // The gateway catalog is global, but its persisted snapshot can survive a
      // Codex CLI upgrade and otherwise hide models exposed only by later
      // accounts. Refresh when the snapshot is stale or its account/version
      // signature no longer matches; probe every Codex account in that refresh.
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
      return collectGatewayModelIds(state, result.byAccount);
    }
    const accountScope = normalizeAccountScope({ accountRef });
    const accounts = state.accounts && state.accounts[provider];
    if (!accountScope || !Array.isArray(accounts)
      || !accounts.some((account) => account.accountRef === accountScope.accountRef)) {
      throw new ChatRuntimeError('chat_session_account_mismatch', 409);
    }
    // 复用 WebUI 的持久缓存、账号首探和失败退避，避免 Chat 等待后台调度器。
    const cache = await getWebUiModelsCache(state, options, {
      ...deps,
      accountScope,
      forceRefresh: accountScopeNeverProbed(state, deps, accountScope),
      timeoutMs: 8000
    });
    // 缓存已经是这个账号的可用目录（WebUI 模型菜单与路由共用同一份），先直接返回。
    // 之前这里丢掉了 cache 结果、又走一遍 discoverProviderModels；对 Go 接管且凭据只存在
    // nativeAuth 的账号（zcode OAuth、codex 网关账号等），探测门禁会因 state 里没有
    // accessToken 而跳过，结果 composer/catalog 返回 422 —— 表现为「切换 provider 后必须
    // 刷新页面才出模型」。
    const cachedModels = cache && cache.byAccount && cache.byAccount[accountScope.accountRef];
    if (Array.isArray(cachedModels) && cachedModels.length > 0) {
      return cachedModels.filter((model) => isModelEnabled(provider, accountScope.accountRef, model));
    }
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
