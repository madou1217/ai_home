'use strict';
const crypto = require('node:crypto');
const net = require('node:net');
const WebSocket = require('ws');

const {
  FALLBACK_MODELS,
  initModelRegistry,
  getRegistryModelList,
  buildOpenAIModelsList
} = require('./models');
const { renderProxyStatusPage } = require('./status-page');
const { rotateIfOversized, sweepAihLogs, resolveMaxBytes } = require('./log-rotation');
const {
  initProxyMetrics,
  createProviderExecutor,
  pushMetricError
} = require('./local');
const { createAccountStateIndex } = require('../account/state-index');
const { createAccountStateService } = require('../account/state-service');
const { createAccountQueryService } = require('../account/query-service');
const { deleteSelfRelayAccounts } = require('../account/self-relay-account');
const {
  parseAuthorizationBearer,
  readRequestBody,
  writeJson,
  fetchWithTimeout,
  fetchModelsForAccount,
  fetchGeminiCodeAssistChatCompletion,
  fetchGeminiCodeAssistChatCompletionStream,
  fetchGeminiCodeAssistGenerateContent,
  fetchGeminiCodeAssistGenerateContentStream
} = require('./http-utils');
const {
  fetchCodeAssistAnthropicMessage,
  fetchCodeAssistAnthropicMessageStream
} = require('./code-assist-anthropic-adapter');
const {
  fetchOpenCodeChatCompletion,
  fetchOpenCodeChatCompletionStream
} = require('./opencode-server-client');
const { loadServerRuntimeAccounts } = require('./accounts');
const { deriveAccountRuntimeStatus } = require('./account-runtime-state');
const {
  createAccountRuntimeEventHub,
  createAccountRuntimeEventPublisher,
  registerAccountRuntimeEventListeners
} = require('./account-runtime-events');
const {
  resolveRequestProvider,
  chooseServerAccount,
  markProxyAccountSuccess,
  markProxyAccountFailure
} = require('./router');
const {
  buildManagementStatusPayload,
  buildManagementMetricsPayload,
  buildManagementAccountsPayload,
  applyReloadState
} = require('./management');
const { buildManagementModelsResponse } = require('./model-endpoints');
const {
  handleUpstreamModels,
  handleUpstreamPassthrough
} = require('./upstream-endpoints');
const {
  handleCodexModels,
  handleCodexChatCompletions
} = require('./codex-adapter');
const { refreshCodexAccessToken } = require('./codex-token-refresh');
const { createTokenRefreshDaemon } = require('./token-refresh-daemon');
const { handleManagementRequest } = require('./management-router');
const { handleNodeRpcRequest } = require('./node-rpc-router');
const { handleFabricRequest } = require('./fabric-router');
const { authorizeWebUiRequest } = require('./webui-auth-gate');
const { resolveProxyTarget, proxyWebUiRequest } = require('./webui-server-proxy');
const { createFabricWebrtcSignalingStore } = require('./fabric-webrtc-signaling');
const { handleV1Request } = require('./v1-router');
const {
  cleanupAuthJobArtifacts,
  getAuthJobManager,
  handleWebUIRequest
} = require('./web-ui-router');
const {
  handleAccountsWatchUpgrade,
  removeLiveAccountRecord
} = require('./webui-account-live');
const { withAccountQueryListFns } = require('./account-load-args');
const { startRuntimeRecoveryDaemon } = require('./runtime-recovery-daemon');
const { startServerSourceAutoRestart } = require('./source-auto-restart');
const {
  createProxyServerState,
  printProxyServeStartup
} = require('./server-runtime');
const { ensureWebUiModelRefreshScheduler } = require('./webui-model-refresh-scheduler');
const {
  readServerConfig,
  writeServerConfig
} = require('./server-config-store');
const { pickProjectDirectory } = require('./project-picker');
const {
  createCodexAppServerProxy,
  isCodexAppServerUpgradePath
} = require('./codex-app-server-proxy');
const { SUPPORTED_SERVER_PROVIDERS } = require('./providers');
const { createCodexDesktopHookService } = require('./codex-desktop-hook');
const { createCodexVscodeHookService } = require('./codex-vscode-hook');
const { createCodexCliHookService } = require('./codex-cli-hook');
const { createRelaySessionRegistry } = require('./remote/relay-session-registry');
const { createWebrtcSessionRegistry } = require('./remote/webrtc-session-registry');
const {
  RELAY_NODE_PATH,
  handleRelayNodeUpgrade,
  requestRelayManagement,
  requestRelayManagementStream
} = require('./remote/relay-server');
const {
  requestRemoteManagement: requestRemoteManagementDefault,
  streamRemoteManagement: streamRemoteManagementDefault
} = require('./remote/remote-gateway');
const {
  hasWebrtcManagementSession,
  requestWebrtcManagement,
  waitForWebrtcManagementSession
} = require('./remote/webrtc-management-adapter');
const { createFabricBrokerSessionRegistry } = require('./fabric-broker-session-registry');
const {
  FABRIC_BROKER_CONTROL_PATH,
  handleFabricBrokerControlUpgrade
} = require('./fabric-broker-router');
const {
  FABRIC_TRANSPORT_ECHO_PATH,
  handleFabricTransportEchoUpgrade
} = require('./fabric-transport-echo-router');
const { detectCodexClientVersion } = require('./codex-client-version');
const { loadAliases } = require('./model-alias-store');
const {
  loadModelCatalogSettings,
  saveModelCatalogSettings
} = require('./model-catalog-settings-store');
const { getProjectsSnapshot } = require('./webui-project-cache');
const {
  buildServerUrl,
  normalizeServerPort
} = require('./server-defaults');
const { collectCommandCandidates } = require('../runtime/platform-runtime');
const { createModelUsageService } = require('../usage/model-usage-service');
const { createModelUsageScanScheduler } = require('../usage/model-usage-scheduler');
const {
  startCodexSessionNotificationBridge
} = require('./codex-session-notification-queue');
const { defaultSessionEventBus } = require('./session-event-bus');

const DEFAULT_MAX_REQUEST_BODY_BYTES = 10 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 70_000;
const DEFAULT_HEADERS_TIMEOUT_MS = 75_000;
const DEFAULT_KEEP_ALIVE_TIMEOUT_MS = 5_000;
const DEFAULT_CODEX_CLI_HOOK_SELF_HEAL_INTERVAL_MS = 15_000;
const DEFAULT_CODEX_DESKTOP_HOOK_SELF_HEAL_INTERVAL_MS = 15_000;

function createRequestId() {
  try {
    return crypto.randomBytes(4).toString('hex');
  } catch (_error) {
    return String(Date.now());
  }
}

function requestClientIp(req) {
  const viaHeader = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  if (viaHeader) return viaHeader;
  return String((req.socket && req.socket.remoteAddress) || '').trim() || 'unknown';
}

function canListenOnPort(host, port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    let settled = false;
    const finish = (available) => {
      if (settled) return;
      settled = true;
      resolve(Boolean(available));
    };
    probe.once('error', () => finish(false));
    probe.listen(port, host, () => {
      probe.close(() => finish(true));
    });
  });
}

async function resolveListenPort(host, preferredPort) {
  const startPort = normalizeServerPort(preferredPort);
  for (let offset = 0; offset <= 100; offset += 1) {
    const candidate = startPort + offset;
    if (candidate > 65535) break;
    if (await canListenOnPort(host, candidate)) {
      return {
        port: candidate,
        changed: candidate !== startPort,
        reason: candidate !== startPort ? 'preferred_port_in_use' : ''
      };
    }
  }
  throw new Error(`no_available_port_after_${startPort}`);
}

async function startLocalServer(options, deps) {
  const {
    http,
    fs,
    aiHomeDir,
    hostHomeDir,
    processObj,
    spawn,
    spawnSync,
    path,
    resolveCliPath,
    logFile,
    entryFilePath,
    nodeExecPath,
    getToolAccountIds,
    getToolConfigDir,
    getProfileDir,
    checkStatus,
    getLastUsageProbeError,
    getLastUsageProbeState,
    ensureUsageSnapshotAsync,
    codexAuthInvalidReconciler,
    fetchImpl,
    ensureSessionStoreLinks,
    syncGlobalConfigToHost,
    accountArtifactHooks,
    enableCodexDesktopAppHook,
    enableCodexCliHook
  } = deps;
  const loadRuntimeAccounts = typeof deps.loadServerRuntimeAccounts === 'function'
    ? deps.loadServerRuntimeAccounts
    : loadServerRuntimeAccounts;
  const applyRuntimeReloadState = typeof deps.applyReloadState === 'function'
    ? deps.applyReloadState
    : applyReloadState;
  options = { ...options };
  const listenPort = await resolveListenPort(options.host, options.port);
  if (listenPort.changed) {
    if (String((processObj.env && processObj.env.AIH_SERVER_STRICT_PORT) || '').trim() === '1') {
      throw new Error(`port_in_use:${options.port}`);
    }
    console.warn(`\x1b[33m[aih]\x1b[0m port ${options.port} is in use; using ${listenPort.port}`);
    options.port = listenPort.port;
  }
  if (!String(options.codexClientVersion || '').trim()) {
    options.codexClientVersion = detectCodexClientVersion({
      processObj,
      resolveCliPath
    });
  }
  const providerHookReceiverUrl = buildServerUrl(options, '/v0/webui/session-events/provider-hook');
  const accountStateIndex = createAccountStateIndex({
    aiHomeDir,
    fs
  });
  const sessionEventBus = deps.sessionEventBus || defaultSessionEventBus;
  const relaySessionRegistry = deps.relaySessionRegistry || createRelaySessionRegistry();
  const webrtcSessionRegistry = deps.webrtcSessionRegistry || createWebrtcSessionRegistry();
  const fabricBrokerSessionRegistry = deps.fabricBrokerSessionRegistry || createFabricBrokerSessionRegistry();
  const fabricWebrtcSignalingStore = deps.fabricWebrtcSignalingStore || createFabricWebrtcSignalingStore();
  const requestRemoteManagementWithAdapters = async (input, callDeps = {}) => {
    const runner = typeof deps.requestRemoteManagement === 'function'
      ? deps.requestRemoteManagement
      : requestRemoteManagementDefault;
    return runner(input, {
      ...callDeps,
      webrtcSessionRegistry,
      requestWebrtcManagement,
      hasWebrtcManagementSession,
      waitForWebrtcManagementSession
    });
  };
  const streamRemoteManagementWithAdapters = async (input, handlers = {}, callDeps = {}) => {
    const runner = typeof deps.streamRemoteManagement === 'function'
      ? deps.streamRemoteManagement
      : streamRemoteManagementDefault;
    return runner(input, handlers, {
      ...callDeps,
      webrtcSessionRegistry,
      requestWebrtcManagement,
      hasWebrtcManagementSession,
      waitForWebrtcManagementSession
    });
  };
  const projectsSnapshotLoader = typeof deps.getProjectsSnapshot === 'function'
    ? deps.getProjectsSnapshot
    : getProjectsSnapshot;
  const codexSessionNotificationBridge = startCodexSessionNotificationBridge({
    fs,
    aiHomeDir,
    bus: sessionEventBus
  });
  const accountStateService = createAccountStateService({
    fs,
    accountStateIndex,
    getProfileDir
  });
  const accountQueryService = createAccountQueryService({
    accountStateIndex
  });

  try {
    deleteSelfRelayAccounts({
      fs,
      profilesDir: path.join(aiHomeDir, 'profiles'),
      aiHomeDir,
      getProfileDir,
      getToolConfigDir,
      checkStatus,
      accountStateIndex,
      accountStateService,
      serverPort: options.port
    });
  } catch (_error) {}

  const logMaxBytes = resolveMaxBytes(processObj.env);
  let proxyLogWrites = 0;
  function appendProxyRequestLog(entry) {
    const line = JSON.stringify(entry);
    try {
      // server.log is the fastest grower (one line per proxied request); cap it
      // in real time. statSync is cheap, but only check every 64 writes.
      if ((proxyLogWrites++ & 63) === 0) {
        rotateIfOversized(fs, path, logFile, logMaxBytes);
      }
      fs.appendFileSync(logFile, `${line}\n`);
    } catch (e) {}
  }

  const state = createProxyServerState(options, {
    loadServerRuntimeAccounts: loadRuntimeAccounts,
    initProxyMetrics,
    createProviderExecutor,
    initModelRegistry,
    fs,
    aiHomeDir,
    accountStateIndex,
    accountStateService,
    accountQueryService,
    getToolAccountIds,
    getToolConfigDir,
    getProfileDir,
    checkStatus
  });
  const modelUsageService = createModelUsageService({
    fs,
    path,
    aiHomeDir,
    hostHomeDir,
    fetchImpl
  });
  const modelUsageScanScheduler = createModelUsageScanScheduler({
    modelUsageService,
    config: {
      enabled: options.modelUsageScan !== false,
      startDelayMs: options.modelUsageScanStartDelayMs,
      intervalMs: options.modelUsageScanIntervalMs
    },
    logInfo: (msg) => {
      if (options.verbose || options.debug) {
        console.log(`\x1b[90m[aih:model-usage]\x1b[0m ${msg}`);
      }
    },
    logWarn: (msg) => {
      console.warn(`\x1b[33m[aih:model-usage]\x1b[0m ${msg}`);
    }
  });

  try {
    state.modelAliases = await loadAliases(fs, aiHomeDir);
  } catch (err) {
    console.warn(`\\x1b[33m[aih:model-alias]\\x1b[0m Failed to load aliases: ${err.message}`);
    state.modelAliases = { aliases: [] };
  }

  try {
    state.modelCatalogSettings = await loadModelCatalogSettings(fs, aiHomeDir);
  } catch (err) {
    console.warn(`\\x1b[33m[aih:model-catalog]\\x1b[0m Failed to load model catalog settings: ${err.message}`);
    state.modelCatalogSettings = { version: 1, models: [], updatedAt: 0 };
  }

  const accountRuntimeEvents = createAccountRuntimeEventHub({
    onError: (error, event) => {
      const msg = String((error && error.message) || error || 'unknown_error');
      const provider = String(event && event.provider || '').trim();
      const accountId = String(event && event.accountId || '').trim();
      console.warn(`\x1b[33m[aih:runtime-event]\x1b[0m ${provider}#${accountId}: ${msg}`);
    }
  });
  registerAccountRuntimeEventListeners(accountRuntimeEvents, {
    state,
    options,
    fs,
    accountStateIndex,
    accountStateService,
    accountQueryService,
    loadServerRuntimeAccounts: loadRuntimeAccounts,
    applyReloadState: applyRuntimeReloadState,
    getToolAccountIds,
    getToolConfigDir,
    getProfileDir,
    checkStatus
  });
  const accountRuntimeEventPublisher = createAccountRuntimeEventPublisher(accountRuntimeEvents);

  function reloadRuntimeAccountsForLiveDelete() {
    if (typeof loadRuntimeAccounts !== 'function' || typeof applyRuntimeReloadState !== 'function') {
      return false;
    }
    const runtimeAccounts = loadRuntimeAccounts(withAccountQueryListFns({
      fs,
      accountStateIndex,
      getToolAccountIds,
      getToolConfigDir,
      getProfileDir,
      checkStatus,
      aiHomeDir,
      serverPort: options.port
    }, {
      accountStateService,
      accountQueryService
    }));
    applyRuntimeReloadState(state, runtimeAccounts);
    return true;
  }

  const unsubscribeCodexAuthInvalidDeletion = (
    codexAuthInvalidReconciler
    && typeof codexAuthInvalidReconciler.onAccountDeleted === 'function'
  )
    ? codexAuthInvalidReconciler.onAccountDeleted((event) => {
      const provider = String(event && event.provider || '').trim().toLowerCase();
      const accountId = String(event && event.accountId || '').trim();
      if (!provider || !accountId) return;
      try {
        reloadRuntimeAccountsForLiveDelete();
      } catch (_error) {}
      removeLiveAccountRecord({
        state,
        fs,
        aiHomeDir
      }, provider, accountId, event && event.reason || 'auth_invalid_deleted');
    })
    : null;

  function markProxyAccountSuccessAndPersist(account, options = {}) {
    const previousStatus = deriveAccountRuntimeStatus(account).status;
    // Forward { model } so a per-model success clears that model's cooldown.
    markProxyAccountSuccess(account, options);
    // 需求：上游成功只发布状态事实，DB 持久化和 pool/cache 维护交给 runtime event listener。
    accountRuntimeEventPublisher.publishChanged(account, previousStatus, 'server.upstream.success');
  }

  function markProxyAccountFailureAndPersist(account, reason, cooldownMs, failureThreshold, options = {}) {
    const previousStatus = deriveAccountRuntimeStatus(account).status;
    // Forward { scope, model } so 429/quota/capacity cool only the (account,
    // model) tuple instead of the whole account. Dropping this arg silently
    // turned every model-scoped failure back into an account-wide cooldown.
    markProxyAccountFailure(account, reason, cooldownMs, failureThreshold, options);
    // 需求：上游失败不能在 adapter 里直接维护 server 池，必须通过 runtime event 解耦副作用。
    accountRuntimeEventPublisher.publishChanged(account, previousStatus, 'server.upstream.failure');
  }

  function chooseServerAccountWithRuntimeSync(accounts, cursorState, cursorKey, selectionOptions = {}) {
    return chooseServerAccount(accounts, cursorState, cursorKey, {
      ...selectionOptions,
      accountStateIndex
    });
  }

  function refreshCodexAccessTokenWithHooks(account, refreshOptions = {}, refreshDeps = {}) {
    return refreshCodexAccessToken(account, refreshOptions, {
      ...refreshDeps,
      accountArtifactHooks
    });
  }

  const requiredClientKey = String(options.clientKey || '').trim();
  const requiredManagementKey = String(options.managementKey || '').trim();
  const cooldownMs = Math.max(1000, Number(options.cooldownMs) || 60000);
  const maxRequestBodyBytes = Math.max(1024, Number(options.maxRequestBodyBytes) || DEFAULT_MAX_REQUEST_BODY_BYTES);
  const codexAppServerProxy = createCodexAppServerProxy({
    spawn,
    processObj,
    path,
    resolveCliPath,
    hostHomeDir,
    logDebug: (msg) => {
      if (options.verbose || options.debug) {
        console.log(`\x1b[90m[aih:codex-proxy]\x1b[0m ${msg}`);
      }
    },
    logError: (error) => {
      const msg = String((error && error.message) || error || 'unknown_error');
      console.error(`\x1b[31m[aih:codex-proxy]\x1b[0m ${msg}`);
    }
  });
  const codexDesktopHookService = enableCodexDesktopAppHook
    ? createCodexDesktopHookService({
      fs,
      path,
      processObj,
      spawnSync,
      aiHomeDir,
      hostHomeDir,
      nodeExecPath,
      providerHookReceiverUrl
    })
    : null;
  const codexVscodeHookService = enableCodexDesktopAppHook
    ? createCodexVscodeHookService({
      fs,
      path,
      processObj,
      spawnSync,
      aiHomeDir,
      hostHomeDir,
      nodeExecPath
    })
    : null;
  const codexCliHookService = enableCodexCliHook
    ? createCodexCliHookService({
      fs,
      path,
      processObj,
      aiHomeDir,
      nodeExecPath,
      resolveCliPath,
      collectCliPaths: collectCommandCandidates
    })
    : null;

  if (codexCliHookService) {
    try {
      const hookResult = codexCliHookService.ensureInstalled();
      if ((options.verbose || options.debug) && hookResult && hookResult.supported) {
        const hookState = hookResult.enabled ? 'enabled' : (hookResult.reason || 'disabled');
        console.log(`\x1b[90m[aih:codex-cli-hook]\x1b[0m cli hook ${hookState}`);
      }
    } catch (error) {
      console.warn(`\x1b[33m[aih:codex-cli-hook]\x1b[0m ${String((error && error.message) || error || 'hook_failed')}`);
    }
  }

  const codexCliHookSelfHeal = codexCliHookService
    ? (() => {
      const intervalMs = Math.max(
        1_000,
        Number(options.codexCliHookSelfHealIntervalMs) || DEFAULT_CODEX_CLI_HOOK_SELF_HEAL_INTERVAL_MS
      );
      let repairing = false;
      const tick = () => {
        if (repairing) return;
        repairing = true;
        try {
          const result = codexCliHookService.ensureInstalled();
          if (result && result.repaired) {
            console.log(`\x1b[36m[aih:codex-cli-hook]\x1b[0m repaired cli hook at ${String(result.targetBinaryPath || '').trim()}`);
          }
        } catch (error) {
          const msg = String((error && error.message) || error || 'hook_failed');
          console.warn(`\x1b[33m[aih:codex-cli-hook]\x1b[0m self-heal failed: ${msg}`);
        } finally {
          repairing = false;
        }
      };
      const timer = setInterval(tick, intervalMs);
      if (typeof timer.unref === 'function') timer.unref();
      return {
        stop() {
          clearInterval(timer);
        },
        tick
      };
    })()
    : null;

  if (codexDesktopHookService) {
    try {
      const hookResult = codexDesktopHookService.activate();
      let traceUpdateResult = null;
      if (
        options.codexDesktopTraceFile
        || options.codexDesktopTraceResponses
        || options.codexDesktopTraceRemoteControl
        || options.codexDesktopRemoteControlProxy !== undefined
      ) {
        traceUpdateResult = codexDesktopHookService.updateTraceConfig({
          traceFile: options.codexDesktopTraceFile,
          traceResponses: options.codexDesktopTraceResponses,
          traceRemoteControl: options.codexDesktopTraceRemoteControl,
          remoteControlProxy: options.codexDesktopRemoteControlProxy
        });
      }
      if (
        (
          traceUpdateResult && traceUpdateResult.changed
          || hookResult && hookResult.helperScriptChanged
        )
        && typeof codexDesktopHookService.restartRunningAppServers === 'function'
      ) {
        if (options.codexDesktopRestartAppServerOnHookChange === true) {
          const restartResult = codexDesktopHookService.restartRunningAppServers();
          if (restartResult && restartResult.count > 0) {
            console.log(`\x1b[36m[aih:codex-hook]\x1b[0m restarted ${restartResult.count} desktop app-server process(es) for hook config update`);
          }
          if (codexVscodeHookService && typeof codexVscodeHookService.restartRunningAppServers === 'function') {
            const vscodeRestartResult = codexVscodeHookService.restartRunningAppServers();
            if (vscodeRestartResult && vscodeRestartResult.count > 0) {
              console.log(`\x1b[36m[aih:codex-vscode-hook]\x1b[0m restarted ${vscodeRestartResult.count} vscode app-server process(es) for hook config update`);
            }
          }
        } else if (options.verbose || options.debug) {
          console.log(`\x1b[90m[aih:codex-hook]\x1b[0m desktop app-server reload pending; set AIH_SERVER_CODEX_DESKTOP_RESTART_APP_SERVER_ON_HOOK_CHANGE=1 to force restart`);
        }
      }
      if ((options.verbose || options.debug) && hookResult && hookResult.supported) {
        const hookState = hookResult.enabled ? 'enabled' : (hookResult.reason || 'disabled');
        console.log(`\x1b[90m[aih:codex-hook]\x1b[0m desktop hook ${hookState}`);
      }
    } catch (error) {
      console.warn(`\x1b[33m[aih:codex-hook]\x1b[0m ${String((error && error.message) || error || 'hook_failed')}`);
    }
  }

  if (codexVscodeHookService) {
    try {
      const hookResult = codexVscodeHookService.activate();
      if ((options.verbose || options.debug) && hookResult && hookResult.supported) {
        const hookState = hookResult.enabled
          ? `enabled (${Number(hookResult.installed || 0)} installed)`
          : (hookResult.reason || 'disabled');
        console.log(`\x1b[90m[aih:codex-vscode-hook]\x1b[0m vscode hook ${hookState}`);
      }
    } catch (error) {
      console.warn(`\x1b[33m[aih:codex-vscode-hook]\x1b[0m ${String((error && error.message) || error || 'hook_failed')}`);
    }
  }

  const codexVscodeHookSelfHeal = codexVscodeHookService
    ? (() => {
      const intervalMs = Math.max(
        1_000,
        Number(options.codexDesktopHookSelfHealIntervalMs) || DEFAULT_CODEX_DESKTOP_HOOK_SELF_HEAL_INTERVAL_MS
      );
      let repairing = false;
      const tick = () => {
        if (repairing) return;
        repairing = true;
        try {
          const result = codexVscodeHookService.ensureInstalled();
          if (result && result.repaired) {
            console.log(`\x1b[36m[aih:codex-vscode-hook]\x1b[0m repaired vscode hook`);
          }
        } catch (error) {
          const msg = String((error && error.message) || error || 'hook_failed');
          console.warn(`\x1b[33m[aih:codex-vscode-hook]\x1b[0m self-heal failed: ${msg}`);
        } finally {
          repairing = false;
        }
      };
      const timer = setInterval(tick, intervalMs);
      if (typeof timer.unref === 'function') timer.unref();
      return {
        stop() {
          clearInterval(timer);
        },
        tick
      };
    })()
    : null;

  const codexDesktopHookSelfHeal = codexDesktopHookService
    ? (() => {
      const intervalMs = Math.max(
        1_000,
        Number(options.codexDesktopHookSelfHealIntervalMs) || DEFAULT_CODEX_DESKTOP_HOOK_SELF_HEAL_INTERVAL_MS
      );
      let repairing = false;
      const tick = () => {
        if (repairing) return;
        repairing = true;
        try {
          const result = codexDesktopHookService.ensureInstalled();
          if (result && result.repaired) {
            let traceUpdateResult = null;
            if (
              options.codexDesktopTraceFile
              || options.codexDesktopTraceResponses
              || options.codexDesktopTraceRemoteControl
              || options.codexDesktopRemoteControlProxy !== undefined
            ) {
              traceUpdateResult = codexDesktopHookService.updateTraceConfig({
                traceFile: options.codexDesktopTraceFile,
                traceResponses: options.codexDesktopTraceResponses,
                traceRemoteControl: options.codexDesktopTraceRemoteControl,
                remoteControlProxy: options.codexDesktopRemoteControlProxy
              });
            }
            if (
              (
                traceUpdateResult && traceUpdateResult.changed
                || result && result.helperScriptChanged
              )
              && typeof codexDesktopHookService.restartRunningAppServers === 'function'
            ) {
              if (options.codexDesktopRestartAppServerOnHookChange === true) {
                codexDesktopHookService.restartRunningAppServers();
              }
            }
            console.log(`\x1b[36m[aih:codex-hook]\x1b[0m repaired desktop hook at ${String(result.targetBinaryPath || '').trim()}`);
          }
        } catch (error) {
          const msg = String((error && error.message) || error || 'hook_failed');
          console.warn(`\x1b[33m[aih:codex-hook]\x1b[0m self-heal failed: ${msg}`);
        } finally {
          repairing = false;
        }
      };
      const timer = setInterval(tick, intervalMs);
      if (typeof timer.unref === 'function') timer.unref();
      return {
        stop() {
          clearInterval(timer);
        },
        tick
      };
    })()
    : null;

  function buildWebUiDeps() {
    return {
      fs,
      writeJson,
      readRequestBody,
      spawnImpl: deps.spawn,
      accountStateIndex,
      accountStateService,
      accountQueryService,
      getToolAccountIds,
      getToolConfigDir,
      getProfileDir,
      loadServerRuntimeAccounts: loadRuntimeAccounts,
      applyReloadState: applyRuntimeReloadState,
      checkStatus,
      getLastUsageProbeError,
      getLastUsageProbeState,
      ensureUsageSnapshotAsync,
      codexAuthInvalidReconciler,
      aiHomeDir,
      ensureSessionStoreLinks,
      syncGlobalConfigToHost,
      sessionEventBus,
      accountArtifactHooks,
      providerHookReceiverUrl,
      codexClientVersion: options.codexClientVersion,
      pickProjectDirectory,
      fetchModelsForAccount,
      buildManagementStatusPayload,
      buildManagementMetricsPayload,
      buildManagementAccountsPayload,
      modelUsageService,
      fetchImpl,
      relaySessionRegistry,
      requestRelayManagement,
      requestRelayManagementStream,
      webrtcSessionRegistry,
      requestWebrtcManagement,
      hasWebrtcManagementSession,
      waitForWebrtcManagementSession,
      readServerConfig: () => readServerConfig({ fs, aiHomeDir }),
      writeServerConfig: (config) => writeServerConfig(config, { fs, aiHomeDir }),
      restartServerWithStoredConfig: async () => {
        const config = readServerConfig({ fs, aiHomeDir });
        const child = spawn(nodeExecPath || process.execPath, [entryFilePath, 'server', 'restart'], {
          detached: true,
          stdio: 'ignore',
          env: processObj.env || process.env
        });
        child.unref();
        return {
          ok: true,
          pid: child.pid,
          appliedConfig: config
        };
      }
    };
  }

  const server = http.createServer(async (req, res) => {
    const requestId = createRequestId();
    const startedAt = Date.now();
    const clientIp = requestClientIp(req);
    res.setHeader('x-aih-request-id', requestId);

    const method = String(req.method || 'GET').toUpperCase();
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname || '/';
    const requestMeta = { requestId, clientIp, method, pathname };
    let loggedAccess = false;
    const logAccessOnce = () => {
      if (loggedAccess || !options.logRequests) return;
      loggedAccess = true;
      appendProxyRequestLog({
        at: new Date().toISOString(),
        kind: 'access',
        requestId,
        method,
        path: pathname,
        status: Number(res.statusCode || 0),
        durationMs: Date.now() - startedAt,
        clientIp
      });
    };
    res.once('finish', logAccessOnce);
    res.once('close', logAccessOnce);
    try {
      if (pathname === '/healthz') {
        return writeJson(res, 200, { ok: true, service: 'aih-server' });
      }
      if (pathname === '/readyz') {
        const accounts = SUPPORTED_SERVER_PROVIDERS.reduce((acc, provider) => {
          acc[provider] = Array.isArray(state.accounts[provider]) ? state.accounts[provider].length : 0;
          return acc;
        }, {});
        return writeJson(res, 200, {
          ok: true,
          service: 'aih-server',
          ready: Object.values(accounts).some((count) => count > 0),
          accounts
        });
      }

      if (pathname.startsWith('/v0/webui/')) {
        // WebUI 数据面鉴权门（R2）：未配对设备一律 401，localhost 不豁免。
        const gate = authorizeWebUiRequest({ req, url, requiredManagementKey, deps: { fs, aiHomeDir } });
        if (!gate.ok) {
          return writeJson(res, gate.statusCode || 401, { ok: false, error: gate.error || 'webui_unauthorized' });
        }
        // R1 薄壳：若请求指向另一台已配对 server，本地 server 透明转发到该 server 的 /v0/webui/*，
        // 完整功能跟随当前 server（等价 workspace 迁到另一台电脑）。
        const proxyTarget = resolveProxyTarget({ req, requestHost: req.headers.host, deps: { fs, aiHomeDir } });
        if (proxyTarget) {
          await proxyWebUiRequest({ req, res, url, target: proxyTarget, deps: {} });
          return;
        }
      }

      const handledWebUI = await handleWebUIRequest({
        method,
        pathname,
        url,
        req,
        res,
        options,
        state,
        deps: buildWebUiDeps()
      });
      if (handledWebUI) return;

      const handledFabric = await handleFabricRequest({
        method,
        pathname,
        url,
        req,
        res,
        options,
        state,
        requiredManagementKey,
        deps: {
          writeJson,
          readRequestBody,
          parseAuthorizationBearer,
          fs,
          aiHomeDir,
          requiredManagementKey,
          fabricBrokerSessionRegistry,
          fabricWebrtcSignalingStore,
          webrtcSessionRegistry,
          requestWebrtcManagement,
          hasWebrtcManagementSession,
          waitForWebrtcManagementSession,
          clientIp
        }
      });
      if (handledFabric) return;

      const handledNodeRpc = await handleNodeRpcRequest({
        method,
        pathname,
        url,
        req,
        res,
        options,
        state,
        requiredManagementKey,
        deps: {
          parseAuthorizationBearer,
          writeJson,
          readRequestBody,
          fs,
          spawnSync,
          aiHomeDir,
          fetchImpl,
          buildManagementStatusPayload,
          buildManagementAccountsPayload,
          getProjectsSnapshot: projectsSnapshotLoader,
          accountStateIndex,
          accountStateService,
          relaySessionRegistry,
          requestRelayManagement,
          requestRelayManagementStream,
          webrtcSessionRegistry,
          requestWebrtcManagement,
          hasWebrtcManagementSession,
          waitForWebrtcManagementSession,
          requestRemoteManagement: requestRemoteManagementWithAdapters,
          streamRemoteManagement: streamRemoteManagementWithAdapters,
          options,
          getToolConfigDir,
          getProfileDir,
          checkStatus,
          accountRuntimeEventHub: accountRuntimeEvents,
          cleanupAuthJobArtifacts,
          getAuthJobManager,
          getToolAccountIds,
          loadServerRuntimeAccounts: loadRuntimeAccounts,
          applyReloadState: applyRuntimeReloadState,
          resolveSessionAccountId: (input = {}) => {
            const provider = String(input.provider || '').trim().toLowerCase();
            if (!provider) return '';
            const pool = Array.isArray(state.accounts[provider]) ? state.accounts[provider] : [];
            const account = chooseServerAccountWithRuntimeSync(pool, state.cursors, provider, {
              provider,
              model: input.model,
              sessionKey: input.sessionId || input.projectPath || '',
              excludeIds: []
            });
            return account && account.id ? String(account.id) : '';
          },
          ensureSessionStoreLinks,
          startNativeDeviceSession: deps.startNativeDeviceSession,
          readNativeSessionRunEvents: deps.readNativeSessionRunEvents,
          writeNativeSessionRunInput: deps.writeNativeSessionRunInput,
          abortNativeSessionRun: deps.abortNativeSessionRun
        }
      });
      if (handledNodeRpc) return;

      const handledManagement = await handleManagementRequest({
        method,
        pathname,
        url,
        req,
        res,
        options,
        state,
        requiredManagementKey,
        deps: {
          parseAuthorizationBearer,
          writeJson,
          renderProxyStatusPage,
          buildManagementStatusPayload,
          buildManagementMetricsPayload,
          buildManagementModelsResponse,
          buildManagementAccountsPayload,
          loadServerRuntimeAccounts: loadRuntimeAccounts,
          applyReloadState: applyRuntimeReloadState,
          fetchModelsForAccount,
          getRegistryModelList,
          accountStateIndex,
          accountStateService,
          accountQueryService,
          fs,
          getToolAccountIds,
          getToolConfigDir,
          getProfileDir,
          checkStatus,
          readRequestBody,
          modelUsageService
        }
      });
      if (handledManagement) return;

      const handledV1 = await handleV1Request({
        req,
        res,
        method,
        pathname,
        options,
        state,
        requiredClientKey,
        cooldownMs,
        maxRequestBodyBytes,
        requestMeta,
        deps: {
          parseAuthorizationBearer,
          writeJson,
          readRequestBody,
          buildOpenAIModelsList,
          resolveRequestProvider,
          chooseServerAccount: chooseServerAccountWithRuntimeSync,
          markProxyAccountSuccess: markProxyAccountSuccessAndPersist,
          markProxyAccountFailure: markProxyAccountFailureAndPersist,
          pushMetricError,
          appendProxyRequestLog,
          handleUpstreamModels,
          handleUpstreamPassthrough,
          handleCodexModels,
          handleCodexChatCompletions,
          fetchModelsForAccount,
          fetchGeminiCodeAssistChatCompletion,
          fetchGeminiCodeAssistChatCompletionStream,
          fetchGeminiCodeAssistGenerateContent,
          fetchGeminiCodeAssistGenerateContentStream,
          fetchCodeAssistAnthropicMessage,
          fetchCodeAssistAnthropicMessageStream,
          fetchOpenCodeChatCompletion,
          fetchOpenCodeChatCompletionStream,
          FALLBACK_MODELS,
          fetchWithTimeout,
          refreshCodexAccessToken: refreshCodexAccessTokenWithHooks,
          recordModelUsage: (payload) => modelUsageService.recordApiUsage(payload),
          fs,
          aiHomeDir,
          loadAliases
        }
      });
      if (handledV1) return;

      return writeJson(res, 404, { ok: false, error: 'not_found' });
    } catch (error) {
      const msg = String((error && error.stack) || (error && error.message) || error || 'unknown_error');
      console.error(`\x1b[31m[aih]\x1b[0m request handler failed: ${msg}`);
      if (!res.writableEnded) {
        writeJson(res, 500, { ok: false, error: 'internal_server_error' });
      }
    }
  });
  server.requestTimeout = Math.max(1000, Number(options.requestTimeoutMs) || DEFAULT_REQUEST_TIMEOUT_MS);
  server.headersTimeout = Math.max(1000, Number(options.headersTimeoutMs) || DEFAULT_HEADERS_TIMEOUT_MS);
  server.keepAliveTimeout = Math.max(1000, Number(options.keepAliveTimeoutMs) || DEFAULT_KEEP_ALIVE_TIMEOUT_MS);
  const runtimeRecovery = startRuntimeRecoveryDaemon(state, {
    intervalMs: Number(options.runtimeRecoveryIntervalMs) || 15000
  });
  let sourceAutoRestart = null;

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, resolve);
  });

  sourceAutoRestart = startServerSourceAutoRestart(options, {
    fs,
    path,
    spawn,
    processObj,
    aiHomeDir,
    entryFilePath,
    nodeExecPath
  });

  setImmediate(() => {
    ensureWebUiModelRefreshScheduler({
      state,
      options,
      fs,
      aiHomeDir,
      deps: {
        fs,
        aiHomeDir,
        fetchModelsForAccount
      }
    });
  });
  modelUsageScanScheduler.start();

  // Bound on-disk log growth: sweep all ~/.ai_home *.log/*.jsonl at startup and
  // every 6h (the .jsonl traces/events have no built-in retention otherwise).
  // unref() so it never keeps the daemon alive.
  sweepAihLogs(fs, path, aiHomeDir, { maxBytes: logMaxBytes });
  const logSweepTimer = setInterval(() => {
    try { sweepAihLogs(fs, path, aiHomeDir, { maxBytes: logMaxBytes }); } catch (_error) {}
  }, 6 * 60 * 60 * 1000);
  if (typeof logSweepTimer.unref === 'function') logSweepTimer.unref();

  // ✅ WebSocket 代理: 将客户端连接转发到 Codex 上游服务器
  server.on('upgrade', async (req, socket, head) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname || '/';
    const requestId = createRequestId();
    const clientIp = requestClientIp(req);

    if (pathname === RELAY_NODE_PATH) {
      try {
        handleRelayNodeUpgrade({
          req,
          socket,
          head,
          deps: {
            fs,
            aiHomeDir,
            WebSocket,
            parseAuthorizationBearer,
            relaySessionRegistry,
            clientIp
          }
        });
      } catch (error) {
        const errorMsg = String((error && error.message) || error || 'unknown');
        console.error(`\x1b[31m[aih:relay]\x1b[0m node upgrade failed: ${errorMsg}`);
        socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
        socket.destroy();
      }
      return;
    }

    if (pathname === FABRIC_BROKER_CONTROL_PATH) {
      try {
        handleFabricBrokerControlUpgrade({
          req,
          socket,
          head,
          deps: {
            WebSocket,
            parseAuthorizationBearer,
            fabricBrokerSessionRegistry,
            requiredManagementKey,
            clientIp
          }
        });
      } catch (error) {
        const errorMsg = String((error && error.message) || error || 'unknown');
        console.error(`\x1b[31m[aih:fabric-broker]\x1b[0m control upgrade failed: ${errorMsg}`);
        socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
        socket.destroy();
      }
      return;
    }

    if (pathname === FABRIC_TRANSPORT_ECHO_PATH) {
      try {
        handleFabricTransportEchoUpgrade({
          req,
          socket,
          head,
          deps: {
            WebSocket
          }
        });
      } catch (error) {
        const errorMsg = String((error && error.message) || error || 'unknown');
        console.error(`\x1b[31m[aih:fabric-transport]\x1b[0m echo upgrade failed: ${errorMsg}`);
        socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
        socket.destroy();
      }
      return;
    }

    if (pathname === '/v0/webui/accounts/watch') {
      // WS upgrade 同样过鉴权门（token 走 ?access_token=）。
      const gate = authorizeWebUiRequest({ req, url, requiredManagementKey, deps: { fs, aiHomeDir } });
      if (!gate.ok) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      try {
        const webUiDeps = buildWebUiDeps();
        handleAccountsWatchUpgrade({
          req,
          socket,
          head,
          options,
          state,
          ...webUiDeps,
          deps: webUiDeps
        });
      } catch (error) {
        const errorMsg = String((error && error.message) || error || 'unknown');
        console.error(`\x1b[31m[aih:webui-ws]\x1b[0m accounts watch upgrade failed: ${errorMsg}`);
        socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
        socket.destroy();
      }
      return;
    }

    const isResponsesPath = pathname === '/v1/responses';
    const isCodexAppServerPath = isCodexAppServerUpgradePath(pathname);
    if (!isResponsesPath && !isCodexAppServerPath) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    if (requiredClientKey) {
      const authHeader = String(req.headers.authorization || '').trim();
      const incoming = authHeader.startsWith('Bearer ')
        ? authHeader.slice(7).trim()
        : '';
      if (incoming !== requiredClientKey) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
    }

    if (isCodexAppServerPath) {
      try {
        await codexAppServerProxy.handleUpgrade(req, socket, head, { requestId, clientIp });
      } catch (error) {
        const errorMsg = String((error && error.message) || error || 'unknown');
        console.error(`\x1b[31m[aih:codex-proxy]\x1b[0m upgrade failed: ${errorMsg}`);
        socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        socket.destroy();
      }
      return;
    }

    try {
      // 选择可用的 Codex 账号
      const pool = Array.isArray(state.accounts.codex) ? state.accounts.codex : [];
      const account = chooseServerAccountWithRuntimeSync(pool, state.cursors, 'codex', {
        provider: 'codex',
        sessionKey: '',
        excludeIds: []
      });

      if (!account || !account.accessToken) {
        socket.write('HTTP/1.1 503 Service Unavailable\r\nContent-Type: application/json\r\n\r\n');
        socket.write(JSON.stringify({ ok: false, error: 'no_available_account' }));
        socket.destroy();
        return;
      }

      // ✅ 构建上游 WebSocket URL
      // - API Key 模式: 使用账号配置的 openai_base_url (中转服务器)
      // - OAuth 模式: 使用默认的 codexBaseUrl (官方 ChatGPT API)
      let upstreamBaseUrl = String(options.codexBaseUrl || '').trim().replace(/\/+$/, '');

      // 检查账号是否使用 API Key 模式 (有 openaiBaseUrl 配置)
      if (account.openaiBaseUrl && String(account.openaiBaseUrl).trim()) {
        upstreamBaseUrl = String(account.openaiBaseUrl).trim().replace(/\/+$/, '');
        if (options.verbose || options.debug) {
          console.log(`\x1b[90m[aih:ws]\x1b[0m Account ${account.id} uses API Key mode with base URL: ${upstreamBaseUrl}`);
        }
      }
      if (isLoopbackUrl(upstreamBaseUrl, options.port)) {
        socket.write('HTTP/1.1 503 Service Unavailable\r\nContent-Type: application/json\r\n\r\n');
        socket.write(JSON.stringify({ ok: false, error: 'infinite_loop_detected' }));
        socket.destroy();
        return;
      }

      const upstreamUrl = upstreamBaseUrl.replace(/^https?:/, 'wss:') + '/responses';

      if (options.verbose || options.debug) {
        console.log(`\x1b[90m[aih:ws]\x1b[0m Client ${clientIp} -> upstream ${upstreamUrl} (account ${account.id})`);
      }

      // 创建到上游的 WebSocket 连接
      const upstream = new WebSocket(upstreamUrl, {
        headers: {
          'Authorization': `Bearer ${account.accessToken}`,
          'User-Agent': req.headers['user-agent'] || 'aih-proxy'
        }
      });

      // 等待上游连接建立
      await new Promise((resolve, reject) => {
        upstream.once('open', resolve);
        upstream.once('error', reject);
        setTimeout(() => reject(new Error('upstream_timeout')), 10000);
      });

      // 升级客户端连接
      const wss = new WebSocket.Server({ noServer: true });
      wss.handleUpgrade(req, socket, head, (client) => {
        if (options.verbose || options.debug) {
          console.log(`\x1b[90m[aih:ws]\x1b[0m WebSocket relay established (request_id: ${requestId})`);
        }

        // 双向转发消息
        client.on('message', (data) => {
          if (upstream.readyState === WebSocket.OPEN) {
            upstream.send(data);
          }
        });

        upstream.on('message', (data) => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(data);
          }
        });

        // 错误处理
        client.on('error', (error) => {
          if (options.debug) {
            console.error(`\x1b[31m[aih:ws]\x1b[0m Client error:`, error.message);
          }
          upstream.close();
        });

        upstream.on('error', (error) => {
          if (options.debug) {
            console.error(`\x1b[31m[aih:ws]\x1b[0m Upstream error:`, error.message);
          }
          client.close();
        });

        // 连接关闭
        client.on('close', () => {
          if (options.verbose || options.debug) {
            console.log(`\x1b[90m[aih:ws]\x1b[0m Client disconnected (request_id: ${requestId})`);
          }
          upstream.close();
        });

        upstream.on('close', () => {
          if (options.verbose || options.debug) {
            console.log(`\x1b[90m[aih:ws]\x1b[0m Upstream disconnected (request_id: ${requestId})`);
          }
          client.close();
        });
      });

    } catch (error) {
      const errorMsg = String((error && error.message) || error || 'unknown');
      console.error(`\x1b[31m[aih:ws]\x1b[0m WebSocket upgrade failed: ${errorMsg}`);
      socket.write(`HTTP/1.1 502 Bad Gateway\r\nContent-Type: application/json\r\n\r\n`);
      socket.write(JSON.stringify({ ok: false, error: 'upstream_failed', detail: errorMsg }));
      socket.destroy();
    }
  });

  // 启动后台 Token 自动刷新守护进程
  const tokenRefreshDaemon = createTokenRefreshDaemon(state, options, {
    fetchWithTimeout,
    accountArtifactHooks,
    accountStateService,
    hub: accountRuntimeEvents,
    // 每个刷新 tick 先重载运行池，让上次加载后才出现/刷新 token 的账号（尤其 agy 原生 CLI 登录后
    // 才写 antigravity-oauth-token 的账号）自动重新进池，不再卡 blocked_by_policy 等手动刷新。
    reloadRuntimePool: reloadRuntimeAccountsForLiveDelete,
    logInfo: (msg) => {
      if (options.verbose || options.debug) {
        console.log(`\x1b[90m[aih:token-refresh]\x1b[0m ${msg}`);
      }
    },
    logWarn: (msg) => {
      console.warn(`\x1b[33m[aih:token-refresh]\x1b[0m ${msg}`);
    },
    logError: (msg) => {
      console.error(`\x1b[31m[aih:token-refresh]\x1b[0m ${msg}`);
    }
  });

  let shuttingDown = false;
  const stopServer = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\x1b[90m[aih]\x1b[0m received ${signal}, shutting down server...`);

    // 停止 Token 刷新守护进程
    if (tokenRefreshDaemon && typeof tokenRefreshDaemon.stop === 'function') {
      tokenRefreshDaemon.stop();
    }
    if (runtimeRecovery && typeof runtimeRecovery.stop === 'function') {
      runtimeRecovery.stop();
    }
    if (sourceAutoRestart && typeof sourceAutoRestart.stop === 'function') {
      sourceAutoRestart.stop();
    }
    if (modelUsageScanScheduler && typeof modelUsageScanScheduler.stop === 'function') {
      modelUsageScanScheduler.stop();
    }
    if (codexCliHookSelfHeal && typeof codexCliHookSelfHeal.stop === 'function') {
      codexCliHookSelfHeal.stop();
    }
    if (codexDesktopHookSelfHeal && typeof codexDesktopHookSelfHeal.stop === 'function') {
      codexDesktopHookSelfHeal.stop();
    }
    if (codexVscodeHookSelfHeal && typeof codexVscodeHookSelfHeal.stop === 'function') {
      codexVscodeHookSelfHeal.stop();
    }
    if (codexSessionNotificationBridge && typeof codexSessionNotificationBridge.stop === 'function') {
      codexSessionNotificationBridge.stop();
    }
    if (relaySessionRegistry && typeof relaySessionRegistry.closeAll === 'function') {
      relaySessionRegistry.closeAll();
    }
    if (webrtcSessionRegistry && typeof webrtcSessionRegistry.closeAll === 'function') {
      webrtcSessionRegistry.closeAll();
    }
    if (fabricBrokerSessionRegistry && typeof fabricBrokerSessionRegistry.closeAll === 'function') {
      fabricBrokerSessionRegistry.closeAll();
    }
    if (typeof unsubscribeCodexAuthInvalidDeletion === 'function') {
      unsubscribeCodexAuthInvalidDeletion();
    }

    server.close(() => {
      processObj.exit(0);
    });
    setTimeout(() => {
      processObj.exit(1);
    }, 5000).unref();
  };
  processObj.once('SIGTERM', () => stopServer('SIGTERM'));
  processObj.once('SIGINT', () => stopServer('SIGINT'));

  printProxyServeStartup(options, state, requiredClientKey, requiredManagementKey);

  // 在启动信息后打印 Token 刷新守护进程状态
  if (options.verbose || options.debug) {
    const stats = tokenRefreshDaemon.getStats();
    console.log(`\x1b[90m[aih]\x1b[0m Token refresh daemon started (interval: ${stats.refreshIntervalMs}ms, skew: ${stats.skewMs}ms)`);
    const usageScanState = modelUsageScanScheduler.getState();
    console.log(`\x1b[90m[aih]\x1b[0m Model usage scan scheduler ${usageScanState.enabled ? 'started' : 'disabled'} (interval: ${usageScanState.intervalMs}ms)`);
  }
}

module.exports = {
  startLocalServer
};
