'use strict';

// 会话 Hook 的兼容辅助模块。
//
// 过去这里会在 Server 启动时自动写入用户的 Provider 配置。该行为已经移除；
// 当前写入入口只有 WebUI/显式 API 的用户确认操作。保留本模块仅用于迁移期的
// 调用方兼容，不能在启动路径调用它。

const {
  installProviderSessionHookConfig,
  listInstallableProviderIds
} = require('./provider-session-hook-config');

const SUPPORTED_PROVIDERS = Object.freeze(listInstallableProviderIds());

// 决定要给哪些 provider 装：有账号池的(state.accounts[provider].length>0)才装，避免给没在用的
// provider 无谓改配置。
function resolveInstallProviders(state) {
  const accounts = state && state.accounts && typeof state.accounts === 'object' ? state.accounts : {};
  return SUPPORTED_PROVIDERS.filter((provider) => {
    const pool = accounts[provider];
    return Array.isArray(pool) && pool.length > 0;
  });
}

function ensureProviderSessionHooksInstalled(options = {}) {
  const {
    fs,
    path: pathImpl,
    homeDir,
    receiverUrl,
    senderScriptPath,
    codexVersion,
    providers,
    log
  } = options;

  const list = Array.isArray(providers) && providers.length > 0
    ? providers.filter((p) => SUPPORTED_PROVIDERS.includes(p))
    : [];

  const results = [];
  for (const provider of list) {
    try {
      const result = installProviderSessionHookConfig(provider, {
        fs,
        path: pathImpl,
        homeDir,
        receiverUrl,
        senderScriptPath,
        codexVersion,
        dryRun: false
      });
      results.push({ provider, ok: !!result.ok, changed: !!result.changed, error: result.error || '' });
      if (typeof log === 'function') {
        log(`[session-hook] ${provider}: ${result.ok ? (result.changed ? 'installed' : 'up-to-date') : `failed(${result.error || 'unknown'})`}`);
      }
    } catch (error) {
      results.push({ provider, ok: false, changed: false, error: String((error && error.message) || error) });
      if (typeof log === 'function') {
        log(`[session-hook] ${provider}: error(${String((error && error.message) || error)})`);
      }
    }
  }
  return results;
}

module.exports = {
  SUPPORTED_PROVIDERS,
  resolveInstallProviders,
  ensureProviderSessionHooksInstalled
};
