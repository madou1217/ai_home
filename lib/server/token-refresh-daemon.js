"use strict";

const { startCodexHostProviderSelfHeal } = require("../account/codex-host-provider");
const { createHostAccountSyncs } = require("../account/host-account-sync");

const DEFAULT_REFRESH_INTERVAL_MS = 10 * 60 * 1000;
const DEFAULT_REFRESH_BEFORE_EXPIRY_MS = 30 * 60 * 1000;

// OAuth 后台主动续期、失效抑制与 auth_invalid 状态标记已全部迁移至 Go
// (`internal/runtime/tokenrefreshdaemon`)；此处仅保留宿主原生凭据观察、
// Codex host provider 自愈以及 fail-closed 的 Go 触发代理。
function createTokenRefreshDaemon(_state, options = {}, deps = {}) {
  const {
    fs,
    aiHomeDir,
    hostHomeDir,
    reloadRuntimePool,
    logInfo,
    logWarn,
    triggerGoTokenRefresh: depsTriggerGoTokenRefresh
  } = deps || {};

  const refreshIntervalMs = Math.max(60_000, Number(options && options.tokenRefreshIntervalMs) || DEFAULT_REFRESH_INTERVAL_MS);
  const skewMs = Math.max(2 * refreshIntervalMs, Number(options && options.tokenRefreshBeforeExpiryMs) || DEFAULT_REFRESH_BEFORE_EXPIRY_MS);
  let lastGoTriggerAt = 0;
  let lastGoTriggerError = "";

  const hostAccountSyncs = createHostAccountSyncs({ fs, aiHomeDir, hostHomeDir });
  for (const entry of hostAccountSyncs) {
    entry.sync.start({
      intervalMs: options && options.nativeCredentialSyncIntervalMs,
      onUpdated: () => { if (typeof reloadRuntimePool === "function") reloadRuntimePool(); },
      onError: (reason) => { if (typeof logWarn === "function") logWarn(reason); }
    });
  }

  const hostProviderHeal = startCodexHostProviderSelfHeal({
    fs, aiHomeDir, hostHomeDir,
    intervalMs: options && options.codexHostProviderHealIntervalMs,
    onRepaired: () => { if (typeof logInfo === "function") logInfo("codex_host_provider_restored"); },
    onFailure: ({ result }) => { if (typeof logWarn === "function") logWarn((result && result.reason) || "codex_host_provider_repair_failed"); }
  });

  async function forceRefresh(provider = "") {
    for (const entry of hostAccountSyncs) entry.sync.scan();
    hostProviderHeal.tick();

    const trigger = typeof depsTriggerGoTokenRefresh === "function"
      ? depsTriggerGoTokenRefresh
      : (options && typeof options.triggerGoTokenRefresh === "function" ? options.triggerGoTokenRefresh : null);
    if (!trigger) {
      lastGoTriggerAt = Date.now();
      lastGoTriggerError = "go_core_unavailable";
      return { ok: false, error: "go_core_unavailable" };
    }

    try {
      const result = await trigger(String(provider || "").trim());
      lastGoTriggerAt = Date.now();
      if (!result || result.ok === false) {
        const error = String((result && (result.error || result.errorCode || result.message)) || "go_token_refresh_failed");
        lastGoTriggerError = error;
        return { ...(result && typeof result === "object" ? result : {}), ok: false, error };
      }
      lastGoTriggerError = "";
      if (typeof reloadRuntimePool === "function") reloadRuntimePool();
      return result && typeof result === "object" ? { ok: true, ...result } : { ok: true };
    } catch (error) {
      const message = String((error && error.message) || error || "go_token_refresh_failed");
      lastGoTriggerAt = Date.now();
      lastGoTriggerError = message;
      if (typeof logWarn === "function") logWarn(`Go token refresh trigger failed: ${message}`);
      return { ok: false, error: message };
    }
  }

  return {
    stop: () => {
      for (const entry of hostAccountSyncs) entry.sync.stop();
      hostProviderHeal.stop();
      if (typeof logInfo === "function") logInfo("Token refresh daemon stopped");
    },
    getStats: () => ({
      oauthRefreshOwnedBy: "go",
      refreshIntervalMs,
      skewMs,
      lastGoTriggerAt,
      ...(lastGoTriggerError ? { lastGoTriggerError } : {}),
      ...Object.fromEntries(hostAccountSyncs.map((entry) => [entry.statsKey, entry.sync.getStats()])),
      hostProviderHeal: hostProviderHeal.getState()
    }),
    forceRefresh
  };
}

module.exports = { createTokenRefreshDaemon };
