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
const { acquireServerInstanceLock } = require('./server-singleton');
const { sweepAihLogs, resolveMaxAgeMs, resolveMaxBytes } = require('./log-rotation');
const { appendBoundedJsonLine } = require('./bounded-log-writer');
const { createChatRuntimeComposition } = require('./chat-runtime-composition');
const { createSessionLifecycleComposition } = require('./session-lifecycle/composition');
const { createCliInteractionCoordinator } = require('./cli-interaction-coordinator');
const { createOptionalChatRuntime } = require('./chat-runtime-bootstrap');
const { resolveAihStorageDir } = require('../runtime/aih-storage-layout');
const {
  initProxyMetrics,
  createProviderExecutor,
  pushMetricError
} = require('./local');
const { createAccountStateIndex } = require('../account/state-index');
const { createAccountStateService } = require('../account/state-service');
const { createAccountQueryService } = require('../account/query-service');
const { readDefaultAccountRef } = require('../account/default-account-store');
const { deleteSelfRelayAccounts } = require('../account/self-relay-account');
const { pruneStaleAccountRuntimeProjections } = require('../account/runtime-projection-pruner');
const {
  parseAuthorizationBearer,
  readRequestBody,
  writeJson,
  fetchWithTimeout,
  isLoopbackUrl,
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
const { refreshClaudeAccessToken } = require('./claude-token-refresh');
const { refreshAgyAccessToken } = require('./agy-token-refresh');
const { createTokenRefreshDaemon } = require('./token-refresh-daemon');
const { handleManagementRequest } = require('./management-router');
const { handleNodeRpcRequest } = require('./node-rpc-router');
const { handleFabricRequest } = require('./fabric-router');
const { authorizeWebUiRequest } = require('./webui-auth-gate');
const { createManagementKeyRotationService } = require('./management-key-rotation');
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
const { ensureWebUiModelsCacheLoaded } = require('./webui-model-cache');
const { buildModelAccountIndex } = require('./model-account-index');
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
const { createHookSelfHealLoop } = require('./hook-self-heal');
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
const { createModelUsageService } = require('../usage/model-usage-service');
const { createModelUsageScanScheduler } = require('../usage/model-usage-scheduler');
const {
  startCodexSessionNotificationBridge
} = require('./codex-session-notification-queue');
const { defaultSessionEventBus } = require('./session-event-bus');
const { startServerMdnsDiscovery } = require('./server-mdns-advertiser');
const { createOutboundRelayManager } = require('./outbound-relay-manager');
const { readOutboundRelayConfig } = require('./outbound-relay-config-store');
const {
  DEFAULT_FABRIC_GATEWAY_TIMEOUT_MS,
  proxyFabricGatewayRequest
} = require('./fabric-gateway-fallback');
const { buildFabricGatewayReadiness } = require('./fabric-gateway-capability');
const { proxyFabricGatewayWebSocket } = require('./fabric-gateway-websocket');
const {
  startFrpConfigReconcileLoop
} = require('../cli/services/fabric/frp-config-reconcile-loop');

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
  const manageProcessLifecycle = options.manageProcessLifecycle !== false;
  let serverInstanceLock = null;
  let lifecycleStopping = false;

  // Standalone single-instance guard: refuse to become a second gateway on the
  // same port. Set AIH_SERVER_ALLOW_MULTI=1 to bypass (tests / intentional
  // multi-instance). The ~3s port grace lets a restarting predecessor finish
  // releasing the port before we give up.
  if (aiHomeDir && String((processObj.env && processObj.env.AIH_SERVER_ALLOW_MULTI) || '').trim() !== '1') {
    serverInstanceLock = await acquireServerInstanceLock({
      fs,
      processObj,
      aiHomeDir,
      host: options.host,
      port: options.port,
      portRetries: 15,
      portWaitMs: 200
    });
    if (!serverInstanceLock.ok) {
      if (serverInstanceLock.reason === 'already_running') {
        throw new Error(`another aih server is already running (pid=${serverInstanceLock.pid}); refusing to start a second instance. Use 'aih server restart', stop it first, or set AIH_SERVER_ALLOW_MULTI=1 to override`);
      }
      throw new Error(`port ${options.port} is already in use (held on ${serverInstanceLock.host}); refusing to start a second gateway. Stop the other instance or set AIH_SERVER_ALLOW_MULTI=1 to override`);
    }
  }

  const listenPort = await resolveListenPort(options.host, options.port);
  if (listenPort.changed) {
    if (String((processObj.env && processObj.env.AIH_SERVER_STRICT_PORT) || '').trim() === '1') {
      if (serverInstanceLock && typeof serverInstanceLock.release === 'function') serverInstanceLock.release();
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
  const providerSessionCorrelationRegistry = deps.providerSessionCorrelationRegistry
    || require('./provider-session-correlation-registry').createProviderSessionCorrelationRegistry();
  const relaySessionRegistry = deps.relaySessionRegistry || createRelaySessionRegistry();
  const webrtcSessionRegistry = deps.webrtcSessionRegistry || createWebrtcSessionRegistry();
  const fabricBrokerSessionRegistry = deps.fabricBrokerSessionRegistry || createFabricBrokerSessionRegistry();
  const fabricWebrtcSignalingStore = deps.fabricWebrtcSignalingStore || createFabricWebrtcSignalingStore();
  let outboundRelayManager = null;
  let frpConfigReconcileLoop = null;
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
      path,
      aiHomeDir,
      hostHomeDir,
      processObj,
      ensureSessionStoreLinks,
      accountStateService,
      serverPort: options.port
    });
  } catch (_error) {}

  try {
    const pruned = pruneStaleAccountRuntimeProjections({
      fs,
      path,
      aiHomeDir,
      ensureSessionStoreLinks
    });
    if (pruned.removed > 0 || pruned.failed > 0) {
      console.log(`\x1b[36m[aih]\x1b[0m runtime projections: removed ${pruned.removed}, kept ${pruned.kept}, failed ${pruned.failed}`);
    }
  } catch (error) {
    console.warn(`\x1b[33m[aih]\x1b[0m runtime projection prune skipped: ${String((error && error.message) || error)}`);
  }

  const logMaxBytes = resolveMaxBytes(processObj.env);
  const logMaxAgeMs = resolveMaxAgeMs(processObj.env);
  function appendProxyRequestLog(entry) {
    appendBoundedJsonLine(fs, logFile, entry, { path, maxBytes: logMaxBytes });
  }
  const composeChatRuntime = typeof deps.createChatRuntimeComposition === 'function'
    ? deps.createChatRuntimeComposition
    : createChatRuntimeComposition;
  const chatRuntimeService = createOptionalChatRuntime({
    fs, aiHomeDir, getProfileDir, accountArtifactHooks,
    env: processObj.env,
    spawnSync,
    appendServerLog: appendProxyRequestLog
  }, {
    createComposition: composeChatRuntime,
    warn: (message) => console.warn(`\x1b[33m[aih]\x1b[0m ${message}`)
  });
  const composeSessionLifecycle = typeof deps.createSessionLifecycleComposition === 'function'
    ? deps.createSessionLifecycleComposition
    : createSessionLifecycleComposition;
  const sessionLifecycleService = composeSessionLifecycle({
    fs,
    aiHomeDir,
    hostHomeDir,
    env: processObj.env,
    spawn,
    spawnSync,
    chatRuntimeService,
    codexClientFactory: deps.codexLifecycleClientFactory,
    resolveNativeCliPath: (provider) => resolveCliPath(provider),
    onCodexStderr: (message) => {
      if (options.verbose || options.debug) {
        console.log(`\x1b[90m[aih:session-lifecycle]\x1b[0m ${message}`);
      }
    }
  });
  const cliInteractionCoordinator = chatRuntimeService
    ? createCliInteractionCoordinator({ chatRuntimeService })
    : null;

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
    getToolConfigDir,
    getProfileDir,
    checkStatus
  });
  ensureWebUiModelsCacheLoaded(state, { fs, aiHomeDir });
  state.modelAccountIndex = buildModelAccountIndex(state, options);
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
      const accountRef = String(event && event.accountRef || '').trim();
      console.warn(`\x1b[33m[aih:runtime-event]\x1b[0m ${provider}#${accountRef}: ${msg}`);
    }
  });
  const unregisterAccountRuntimeListeners = registerAccountRuntimeEventListeners(accountRuntimeEvents, {
    state,
    options,
    fs,
    aiHomeDir,
    accountStateIndex,
    accountStateService,
    accountQueryService,
    loadServerRuntimeAccounts: loadRuntimeAccounts,
    applyReloadState: applyRuntimeReloadState,
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
      const accountRef = String(event && event.accountRef || '').trim();
      if (!provider || !accountRef) return;
      try {
        reloadRuntimeAccountsForLiveDelete();
      } catch (_error) {}
      removeLiveAccountRecord({
        state,
        fs,
        aiHomeDir
      }, provider, accountRef, event && event.reason || 'auth_invalid_deleted');
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
    const provider = String(selectionOptions.provider || cursorKey || '').trim().toLowerCase();
    return chooseServerAccount(accounts, cursorState, cursorKey, {
      ...selectionOptions,
      preferredAccountRef: provider
        ? readDefaultAccountRef(fs, aiHomeDir, provider)
        : '',
      accountStateIndex
    });
  }

  function refreshCodexAccessTokenWithHooks(account, refreshOptions = {}, refreshDeps = {}) {
    return refreshCodexAccessToken(account, refreshOptions, {
      ...refreshDeps,
      fs,
      aiHomeDir,
      accountArtifactHooks
    });
  }

  function refreshClaudeAccessTokenWithHooks(account, refreshOptions = {}, refreshDeps = {}) {
    return refreshClaudeAccessToken(account, refreshOptions, {
      ...refreshDeps,
      fs,
      aiHomeDir,
      accountArtifactHooks
    });
  }

  function refreshAgyAccessTokenWithHooks(account, refreshOptions = {}, refreshDeps = {}) {
    return refreshAgyAccessToken(account, refreshOptions, {
      ...refreshDeps,
      fs,
      aiHomeDir,
      accountArtifactHooks
    });
  }

  const requiredClientKey = String(options.clientKey || '').trim();
  const managementKeyRotation = createManagementKeyRotationService({
    initialManagementKey: options.managementKey,
    managementKeySource: options.managementKeySource,
    writeServerConfig: (config) => writeServerConfig(config, { fs, aiHomeDir })
  });
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
      resolveCliPath
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

  const reportHookSelfHealFailure = (label, failure) => {
    if (!failure || (!failure.error && !failure.suspended)) return;
    const result = failure.result || {};
    const detail = failure.error
      ? String(failure.error.message || failure.error || 'hook_failed')
      : [result.reason, result.errorCode].filter(Boolean).join(': ');
    const suffix = failure.suspended ? '; automatic retries suspended until server restart' : '';
    console.warn(`\x1b[33m[aih:${label}]\x1b[0m self-heal failed: ${detail || 'hook_failed'}${suffix}`);
  };

  const codexCliHookSelfHeal = codexCliHookService
    ? createHookSelfHealLoop({
      intervalMs: Math.max(
        1_000,
        Number(options.codexCliHookSelfHealIntervalMs) || DEFAULT_CODEX_CLI_HOOK_SELF_HEAL_INTERVAL_MS
      ),
      ensureInstalled: () => codexCliHookService.ensureInstalled(),
      onRepaired: (result) => {
        console.log(`\x1b[36m[aih:codex-cli-hook]\x1b[0m repaired cli hook at ${String(result.targetBinaryPath || '').trim()}`);
      },
      onFailure: (failure) => reportHookSelfHealFailure('codex-cli-hook', failure)
    })
    : null;

  let codexDesktopHookStartupResult = null;
  if (codexDesktopHookService) {
    try {
      const hookResult = codexDesktopHookService.activate();
      codexDesktopHookStartupResult = hookResult;
      if (hookResult && hookResult.retryable === false) {
        reportHookSelfHealFailure('codex-hook', {
          result: hookResult,
          suspended: true
        });
      }
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
        } else if (options.verbose || options.debug) {
          console.log(`\x1b[90m[aih:codex-hook]\x1b[0m desktop app-server reload disabled by AIH_SERVER_CODEX_DESKTOP_RESTART_APP_SERVER_ON_HOOK_CHANGE=0`);
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
    ? createHookSelfHealLoop({
      intervalMs: Math.max(
        1_000,
        Number(options.codexDesktopHookSelfHealIntervalMs) || DEFAULT_CODEX_DESKTOP_HOOK_SELF_HEAL_INTERVAL_MS
      ),
      ensureInstalled: () => codexVscodeHookService.ensureInstalled(),
      onRepaired: () => {
        console.log(`\x1b[36m[aih:codex-vscode-hook]\x1b[0m repaired vscode hook`);
      },
      onFailure: (failure) => reportHookSelfHealFailure('codex-vscode-hook', failure)
    })
    : null;

  const codexDesktopHookSelfHeal = codexDesktopHookService
    && (!codexDesktopHookStartupResult || codexDesktopHookStartupResult.retryable !== false)
    ? createHookSelfHealLoop({
      intervalMs: Math.max(
        1_000,
        Number(options.codexDesktopHookSelfHealIntervalMs) || DEFAULT_CODEX_DESKTOP_HOOK_SELF_HEAL_INTERVAL_MS
      ),
      ensureInstalled: () => codexDesktopHookService.ensureInstalled(),
      onRepaired: (result) => {
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
          && options.codexDesktopRestartAppServerOnHookChange === true
        ) {
          codexDesktopHookService.restartRunningAppServers();
        }
        console.log(`\x1b[36m[aih:codex-hook]\x1b[0m repaired desktop hook at ${String(result.targetBinaryPath || '').trim()}`);
      },
      onFailure: (failure) => reportHookSelfHealFailure('codex-hook', failure)
    })
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
      hostHomeDir,
      processObj,
      codexDesktopHookService,
      homeDir: deps.sshHomeDir || require('node:os').homedir(),
      ensureSessionStoreLinks,
      syncGlobalConfigToHost,
      sessionEventBus,
      providerSessionCorrelationRegistry,
      chatRuntimeService,
      sessionLifecycleService,
      cliInteractionCoordinator,
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
      rotateManagementKey: (input) => managementKeyRotation.rotate(input),
      applyAihFrpConfig: deps.applyAihFrpConfig,
      discoverFrpcConfigPath: deps.discoverFrpcConfigPath,
      removeAihFrpConfig: deps.removeAihFrpConfig,
      outboundRelayManager,
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
    const requiredManagementKey = managementKeyRotation.getRequiredManagementKey();
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
        const gateway = buildFabricGatewayReadiness(fabricBrokerSessionRegistry);
        return writeJson(res, 200, {
          ok: true,
          service: 'aih-server',
          ready: Object.values(accounts).some((count) => count > 0) || gateway.ready,
          accounts,
          gateway
        });
      }

      if (pathname === '/v0/webui' || pathname.startsWith('/v0/webui/')) {
        // WebUI 数据面鉴权门：所有客户端（包括 loopback）统一使用 Management Key。
        const gate = authorizeWebUiRequest({ req, url, requiredManagementKey, deps: { fs, aiHomeDir } });
        if (!gate.ok) {
          return writeJson(res, gate.statusCode || 401, { ok: false, error: gate.error || 'webui_unauthorized' });
        }
        // R1 薄壳：若请求指向另一台已配置 server，本地 server 透明转发到该 server 的 /v0/webui/*，
        // 完整功能跟随当前 server（等价 workspace 迁到另一台电脑）。
        const proxyTarget = resolveProxyTarget({ req, requestHost: req.headers.host, deps: { fs, aiHomeDir } });
        if (proxyTarget) {
          await proxyWebUiRequest({ req, res, url, target: proxyTarget, deps: { fs, aiHomeDir } });
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
          loadServerRuntimeAccounts: loadRuntimeAccounts,
          applyReloadState: applyRuntimeReloadState,
          resolveSessionAccountRef: (input = {}) => {
            const provider = String(input.provider || '').trim().toLowerCase();
            if (!provider) return '';
            const pool = Array.isArray(state.accounts[provider]) ? state.accounts[provider] : [];
            const account = chooseServerAccountWithRuntimeSync(pool, state.cursors, provider, {
              provider,
              model: input.model,
              sessionKey: input.sessionId || input.projectPath || '',
              excludeAccountRefs: []
            });
            return account && account.accountRef ? String(account.accountRef) : '';
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
          aiHomeDir,
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
          refreshClaudeAccessToken: refreshClaudeAccessTokenWithHooks,
          refreshAgyAccessToken: refreshAgyAccessTokenWithHooks,
          recordModelUsage: (payload) => modelUsageService.recordApiUsage(payload),
          proxyFabricGatewayRequest,
          fabricBrokerSessionRegistry,
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
      if (res.writableEnded || res.destroyed) return;
      if (res.headersSent) {
        try { res.end(); } catch (_error) {}
        return;
      }
      writeJson(res, 500, { ok: false, error: 'internal_server_error' });
    }
  });
  let resolveClosed;
  const closed = new Promise((resolve) => {
    resolveClosed = resolve;
  });
  server.once('close', () => resolveClosed());
  server.requestTimeout = Math.max(1000, Number(options.requestTimeoutMs) || DEFAULT_REQUEST_TIMEOUT_MS);
  server.headersTimeout = Math.max(1000, Number(options.headersTimeoutMs) || DEFAULT_HEADERS_TIMEOUT_MS);
  server.keepAliveTimeout = Math.max(1000, Number(options.keepAliveTimeoutMs) || DEFAULT_KEEP_ALIVE_TIMEOUT_MS);
  const runtimeRecovery = startRuntimeRecoveryDaemon(state, {
    intervalMs: Number(options.runtimeRecoveryIntervalMs) || 15000
  });
  let sourceAutoRestart = null;
  let serverMdnsDiscovery = null;

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, resolve);
  });

  const startFrpReconcile = typeof deps.startFrpConfigReconcileLoop === 'function'
    ? deps.startFrpConfigReconcileLoop
    : startFrpConfigReconcileLoop;
  frpConfigReconcileLoop = startFrpReconcile({
    aiHomeDir,
    intervalMs: options.frpReconcileIntervalMs
  }, {
    reconcileAihFrpConfig: deps.reconcileAihFrpConfig,
    logWarn: (message) => console.warn(`\x1b[33m[aih]\x1b[0m ${message}`)
  });

  const startMdnsDiscovery = typeof deps.startServerMdnsDiscovery === 'function'
    ? deps.startServerMdnsDiscovery
    : startServerMdnsDiscovery;
  const listenHost = String(options.host || '').trim().toLowerCase();
  const mdnsDisabled = String((processObj.env && processObj.env.AIH_SERVER_DISABLE_MDNS) || '').trim() === '1';
  serverMdnsDiscovery = await startMdnsDiscovery({
    fs,
    aiHomeDir,
    host: options.host,
    port: options.port,
    advertise: !mdnsDisabled && !['127.0.0.1', 'localhost', '::1'].includes(listenHost)
  }, {
    logWarn: (message) => console.warn(`\x1b[33m[aih]\x1b[0m ${message}`)
  });
  if (serverMdnsDiscovery && serverMdnsDiscovery.identity) {
    state.serverIdentity = serverMdnsDiscovery.identity;
  }

  if (state.serverIdentity && state.serverIdentity.id) {
    try {
      const buildOutboundRelayManager = typeof deps.createOutboundRelayManager === 'function'
        ? deps.createOutboundRelayManager
        : createOutboundRelayManager;
      const readRelayConfig = typeof deps.readOutboundRelayConfig === 'function'
        ? deps.readOutboundRelayConfig
        : readOutboundRelayConfig;
      outboundRelayManager = buildOutboundRelayManager({
        stableServerId: state.serverIdentity.id,
        localUrl: `http://127.0.0.1:${options.port}`,
        localClientKey: requiredClientKey,
        requestTimeoutMs: DEFAULT_FABRIC_GATEWAY_TIMEOUT_MS
      }, {
        connectFabricBroker: deps.connectFabricBroker,
        fetchImpl
      });
      await outboundRelayManager.start(readRelayConfig({ fs, aiHomeDir }));
    } catch (error) {
      outboundRelayManager = null;
      console.warn(`\x1b[33m[aih]\x1b[0m outbound Server routes unavailable: ${String((error && error.code) || (error && error.message) || error)}`);
    }
  }

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
    if (lifecycleStopping) return;
    ensureWebUiModelRefreshScheduler({
      state,
      options,
      fs,
      aiHomeDir,
      deps: {
        fs,
        aiHomeDir,
        fetchModelsForAccount,
        accountStateService
      }
    });
  });

  // 会话实时同步：确保「有账号池的 provider」的官方 session-sync hook 已安装,让 CLI 会话事件
  // 事件驱动实时推给 web(否则退化成 500ms 文件轮询、会话与 web 不同步渲染)。幂等(已装且匹配则
  // 不写盘)+ best-effort(单 provider 失败只记日志、不阻塞启动、自动降级 watcher fallback)。
  setImmediate(() => {
    if (lifecycleStopping) return;
    try {
      const {
        resolveInstallProviders,
        ensureProviderSessionHooksInstalled
      } = require('./provider-session-hook-autoinstall');
      const providers = resolveInstallProviders(state);
      if (providers.length === 0) return;
      const results = ensureProviderSessionHooksInstalled({
        fs,
        path,
        homeDir: hostHomeDir || require('node:os').homedir(),
        receiverUrl: providerHookReceiverUrl,
        codexVersion: options.codexClientVersion,
        providers,
        log: (line) => console.log(`\x1b[36m[aih]\x1b[0m ${line}`)
      });
      const changed = results.filter((result) => result.changed).length;
      if (changed > 0) {
        console.log(`\x1b[36m[aih]\x1b[0m session-hook: 实时同步 hook 新装 ${changed}/${results.length} 个 provider`);
      }
    } catch (error) {
      console.warn(`\x1b[33m[aih]\x1b[0m session-hook autoinstall failed: ${String((error && error.message) || error)}`);
    }
  });

  // Post-reboot persistent-session restore. With `aih server autostart`
  // installed the server is the first aih process after a reboot, so this is
  // the "load the RDB back into memory" moment: reconcile the session
  // registry and revive reboot-killed tmux sessions in detached children.
  // Async and best-effort — never blocks or fails server startup.
  setImmediate(() => {
    if (lifecycleStopping) return;
    try {
      const restore = typeof deps.restorePersistentSessions === 'function'
        ? deps.restorePersistentSessions
        : require('../cli/services/ai-cli/persistent-session-restore')
          .createPersistentSessionRestore({
            fs,
            path,
            spawn,
            spawnSync,
            processObj,
            aiHomeDir,
            log: (line) => console.log(line)
          }).restorePersistentSessions;
      const result = restore({ reason: 'server-start' }) || {};
      if (result.restored > 0) {
        console.log(`\x1b[36m[aih]\x1b[0m persistent-session restore: re-created ${result.restored} session(s) after reboot`);
      }
    } catch (error) {
      console.warn(`\x1b[33m[aih]\x1b[0m persistent-session restore failed: ${String((error && error.message) || error)}`);
    }
  });

  // 收养 webUI native run 孤儿：上个 server 进程死掉（部署重启/崩溃）时 tmux 里的 CLI run
  // 还活着，重新注册进 run registry（/chat/runs 可见、可 abort），跑完统一收尾
  // （项目快照刷新 + session:turn-completed 发布 → 刷新后的页面能自然结束"运行中"）。
  setImmediate(() => {
    if (lifecycleStopping) return;
    try {
      const { adoptWebUiNativeRuns } = require('./native-run-adoption');
      const runStore = require('./native-chat-run-store');
      const { defaultSessionEventBus } = require('./session-event-bus');
      const result = adoptWebUiNativeRuns({
        aiHomeDir,
        registerNativeChatRun: runStore.registerNativeChatRun,
        unregisterNativeChatRun: runStore.unregisterNativeChatRun,
        log: (line) => console.log(line),
        async onRunFinished(manifest, info) {
          try {
            defaultSessionEventBus.publish({
              provider: manifest.provider,
              sessionId: manifest.sessionId,
              projectDirName: manifest.projectDirName,
              projectPath: manifest.projectPath
            }, {
              source: 'native-run-adoption',
              type: info.exitCode === 0 ? 'session:turn-completed' : 'session:turn-failed',
              phase: info.exitCode === 0 ? 'turn-completed' : 'turn-failed',
              reason: info.adopted ? 'adopted_run_finished' : 'orphan_run_finalized',
              at: Date.now(),
              runId: manifest.runId
            });
          } catch (_error) { /* best-effort */ }
          try {
            const { refreshProjectsSnapshot } = require('./webui-project-cache');
            await refreshProjectsSnapshot({ state }, { forceRefresh: true });
          } catch (_error) { /* best-effort */ }
        }
      });
      if (result.adopted > 0 || result.finalized > 0) {
        console.log(`\x1b[36m[aih]\x1b[0m webui native runs: adopted ${result.adopted}, finalized ${result.finalized}`);
      }
    } catch (error) {
      console.warn(`\x1b[33m[aih]\x1b[0m webui native run adoption failed: ${String((error && error.message) || error)}`);
    }
  });
  modelUsageScanScheduler.start();

  // Bound on-disk log growth: sweep all ~/.ai_home/logs files at startup and
  // every hour (the .jsonl traces/events have no built-in retention otherwise).
  // unref() so it never keeps the daemon alive.
  const logsDir = resolveAihStorageDir(aiHomeDir, 'logs');
  const scheduleInterval = typeof deps.setInterval === 'function' ? deps.setInterval : setInterval;
  const cancelInterval = typeof deps.clearInterval === 'function' ? deps.clearInterval : clearInterval;
  sweepAihLogs(fs, path, logsDir, { maxBytes: logMaxBytes, maxAgeMs: logMaxAgeMs });
  const logSweepTimer = scheduleInterval(() => {
    try { sweepAihLogs(fs, path, logsDir, { maxBytes: logMaxBytes, maxAgeMs: logMaxAgeMs }); } catch (_error) {}
  }, 60 * 60 * 1000);
  if (typeof logSweepTimer.unref === 'function') logSweepTimer.unref();

  // ✅ WebSocket 代理: 将客户端连接转发到 Codex 上游服务器
  server.on('upgrade', async (req, socket, head) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname || '/';
    const requestId = createRequestId();
    const clientIp = requestClientIp(req);
    const requiredManagementKey = managementKeyRotation.getRequiredManagementKey();

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
            WebSocket,
            parseAuthorizationBearer,
            requiredManagementKey
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
      // WS upgrade 同样只接受 Authorization header；浏览器端已统一使用 fetch SSE。
      const gate = authorizeWebUiRequest({ req, url, requiredManagementKey, deps: { fs, aiHomeDir } });
      if (!gate.ok) {
        const statusCode = gate.statusCode === 503 ? 503 : 401;
        const statusText = statusCode === 503 ? 'Service Unavailable' : 'Unauthorized';
        socket.write(`HTTP/1.1 ${statusCode} ${statusText}\r\n\r\n`);
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

    if (await proxyFabricGatewayWebSocket({
      req,
      socket,
      head,
      requestId,
      state
    }, {
      WebSocket,
      fabricBrokerSessionRegistry
    })) return;

    try {
      // 选择可用的 Codex 账号
      const pool = Array.isArray(state.accounts.codex) ? state.accounts.codex : [];
      const account = chooseServerAccountWithRuntimeSync(pool, state.cursors, 'codex', {
        provider: 'codex',
        sessionKey: '',
        excludeAccountRefs: []
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
          console.log(`\x1b[90m[aih:ws]\x1b[0m Account ${account.accountRef} uses API Key mode with base URL: ${upstreamBaseUrl}`);
        }
      }
      if (isLoopbackUrl(upstreamBaseUrl, options.port)) {
        socket.write('HTTP/1.1 503 Service Unavailable\r\nContent-Type: application/json\r\n\r\n');
        socket.write(JSON.stringify({ ok: false, error: 'infinite_loop_detected' }));
        socket.destroy();
        return;
      }

      const upstreamUrl = upstreamBaseUrl
        .replace(/^http:/, 'ws:')
        .replace(/^https:/, 'wss:') + '/responses';

      if (options.verbose || options.debug) {
        console.log(`\x1b[90m[aih:ws]\x1b[0m Client ${clientIp} -> upstream ${upstreamUrl} (account ${account.accountRef})`);
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
    fs,
    aiHomeDir,
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

  let stopPromise = null;
  let processShutdownRequested = false;
  let forceExitTimer = null;

  function onSigterm() {
    requestProcessShutdown('SIGTERM');
  }

  function onSigint() {
    requestProcessShutdown('SIGINT');
  }

  function removeProcessSignalListeners() {
    if (typeof processObj.removeListener !== 'function') return;
    processObj.removeListener('SIGTERM', onSigterm);
    processObj.removeListener('SIGINT', onSigint);
  }

  function invokeLifecycle(target, method) {
    if (!target || typeof target[method] !== 'function') return null;
    return Promise.resolve().then(() => target[method]());
  }

  function stopServer(signal = 'manual') {
    if (stopPromise) return stopPromise;
    lifecycleStopping = true;
    removeProcessSignalListeners();
    console.log(`\x1b[90m[aih]\x1b[0m received ${signal}, shutting down server...`);

    if (server.listening) {
      server.close();
      if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
    } else {
      resolveClosed();
    }

    cancelInterval(logSweepTimer);
    const webUiModelRefreshScheduler = state.webUiModelRefreshScheduler;
    if (webUiModelRefreshScheduler && webUiModelRefreshScheduler.timer) {
      const cancelTimeout = typeof deps.clearTimeout === 'function' ? deps.clearTimeout : clearTimeout;
      cancelTimeout(webUiModelRefreshScheduler.timer);
      webUiModelRefreshScheduler.timer = null;
    }

    const cleanupTasks = [
      invokeLifecycle(tokenRefreshDaemon, 'stop'),
      invokeLifecycle(runtimeRecovery, 'stop'),
      invokeLifecycle(sourceAutoRestart, 'stop'),
      invokeLifecycle(modelUsageScanScheduler, 'stop'),
      invokeLifecycle(modelUsageService, 'close'),
      invokeLifecycle(codexCliHookSelfHeal, 'stop'),
      invokeLifecycle(codexDesktopHookSelfHeal, 'stop'),
      invokeLifecycle(codexVscodeHookSelfHeal, 'stop'),
      invokeLifecycle(codexSessionNotificationBridge, 'stop'),
      invokeLifecycle(chatRuntimeService, 'close'),
      invokeLifecycle(sessionLifecycleService, 'close'),
      invokeLifecycle(relaySessionRegistry, 'closeAll'),
      invokeLifecycle(webrtcSessionRegistry, 'closeAll'),
      invokeLifecycle(fabricBrokerSessionRegistry, 'closeAll'),
      invokeLifecycle(serverMdnsDiscovery, 'stop'),
      invokeLifecycle(outboundRelayManager, 'stop'),
      invokeLifecycle(frpConfigReconcileLoop, 'stop')
    ].filter(Boolean);
    if (typeof unsubscribeCodexAuthInvalidDeletion === 'function') {
      cleanupTasks.push(Promise.resolve().then(() => unsubscribeCodexAuthInvalidDeletion()));
    }
    for (const unregister of unregisterAccountRuntimeListeners) {
      if (typeof unregister === 'function') {
        cleanupTasks.push(Promise.resolve().then(() => unregister()));
      }
    }

    stopPromise = Promise.allSettled([...cleanupTasks, closed])
      .then(() => undefined)
      .finally(() => {
        if (serverInstanceLock && typeof serverInstanceLock.release === 'function') {
          serverInstanceLock.release();
        }
      });
    return stopPromise;
  }

  function requestProcessShutdown(signal) {
    if (processShutdownRequested) return;
    processShutdownRequested = true;
    forceExitTimer = setTimeout(() => {
      processObj.exit(1);
    }, 5000);
    if (forceExitTimer && typeof forceExitTimer.unref === 'function') forceExitTimer.unref();
    stopServer(signal).then(
      () => {
        if (forceExitTimer) clearTimeout(forceExitTimer);
        processObj.exit(0);
      },
      () => processObj.exit(1)
    );
  }

  if (manageProcessLifecycle && typeof processObj.once === 'function') {
    processObj.once('SIGTERM', onSigterm);
    processObj.once('SIGINT', onSigint);
  }

  printProxyServeStartup(
    options,
    state,
    requiredClientKey,
    managementKeyRotation.getRequiredManagementKey()
  );

  // 在启动信息后打印 Token 刷新守护进程状态
  if (options.verbose || options.debug) {
    const stats = tokenRefreshDaemon.getStats();
    console.log(`\x1b[90m[aih]\x1b[0m Token refresh daemon started (interval: ${stats.refreshIntervalMs}ms, skew: ${stats.skewMs}ms)`);
    const usageScanState = modelUsageScanScheduler.getState();
    console.log(`\x1b[90m[aih]\x1b[0m Model usage scan scheduler ${usageScanState.enabled ? 'started' : 'disabled'} (interval: ${usageScanState.intervalMs}ms)`);
  }
  const listeningAddress = server.address();
  const address = Object.freeze({
    host: options.host,
    port: listeningAddress && typeof listeningAddress === 'object'
      ? listeningAddress.port
      : options.port
  });
  return Object.freeze({ server, address, stop: stopServer, closed });
}

module.exports = {
  startLocalServer
};
