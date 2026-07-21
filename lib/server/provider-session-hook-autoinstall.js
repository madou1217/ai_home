'use strict';

// 会话实时同步：启动时确保各 provider 的官方 session-sync hook 已安装。
//
// 背景：hook 接收端(/v0/webui/session-events/provider-hook)→归一化→SessionEventBus→sessions/watch
// SSE 这条实时链路早已 wired，但只有把 hook 安装进 provider 的用户级配置(~/.claude/settings.json、
// ~/.codex/hooks.json 等)后，会话事件才会「事件驱动」实时推给 web；否则退化成 500ms 文件轮询、不实时。
// 之前该安装只能手动 POST /v0/webui/provider-hooks/install 触发，用户从未装 → 会话与 web 不同步渲染。
//
// 这里在启动后对「有账号的 provider」做幂等 ensure-install：已装且匹配则 changed=false 不写盘;
// 未装则装（installProviderSessionHookConfig 用 managed 标记合并、不覆盖用户自有 hook、可卸载）。
// best-effort：任何 provider 失败(只读/权限)只记日志，不影响启动，其它 provider 继续 + 该 provider
// 自动降级到 watcher/poll fallback。

const { installProviderSessionHookConfig } = require('./provider-session-hook-config');

const SUPPORTED_PROVIDERS = ['claude', 'codex', 'gemini', 'agy', 'opencode'];

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
