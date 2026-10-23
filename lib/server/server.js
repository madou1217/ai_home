'use strict';

const { writeFileAtomic } = require('../runtime/atomic-file-write');
const crypto = require('node:crypto');
const net = require('node:net');
const WebSocket = require('ws');

const {
  FALLBACK_MODELS,
  initModelRegistry,
  getRegistryModelList,
  buildOpenAIModelsList
} = require('./models');
const { restoreManagedToolServices } = require('../cli/services/toolkit/tool-service-manager');
const { renderProxyStatusPage } = require('./status-page');
const { acquireServerInstanceLock } = require('./server-singleton');
const { createRelayPortMux } = require('./relay-port-mux');
const { sweepAihLogs, resolveMaxAgeMs, resolveMaxBytes } = require('./log-rotation');
const { appendBoundedJsonLine } = require('./bounded-log-writer');
const { runWithTrace, traceLogFields, currentTrace } = require('./request-trace');
const { createChatRuntimeComposition } = require('./chat-runtime-composition');
const { createChatHarnessModelReader } = require('./chat-runtime/chat-harness-model-reader');
const { createChatAccountModelPolicy } = require('./chat-runtime/chat-account-model-policy');
const { resolveProviderDefaultModel } = require('./provider-default-models');
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
const { createKimiHostCredentialReconciler } = require('../account/kimi-host-credentials');
const { readDefaultAccountRef } = require('../account/default-account-store');
const { deleteSelfRelayAccounts } = require('../account/self-relay-account');
const { pruneStaleAccountRuntimeProjections } = require('../account/runtime-projection-pruner');
const { pruneStaleCodexAppServerStates } = require('./codex-app-server-state-pruner');
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
const { createAccountRuntimeGate } = require('./account-runtime-gate');
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
const { handleImageGenerations } = require('./image-generations-endpoint');
const { createImageStudioStore } = require('./image-studio-store');
const { refreshCodexAccessToken } = require('./codex-token-refresh');
const { refreshClaudeAccessToken } = require('./claude-token-refresh');
const { createClaudeLoginRecovery } = require('../account/claude-login-recovery');
const { refreshAgyAccessToken } = require('./agy-token-refresh');
const { refreshGrokAccessToken } = require('./grok-token-refresh');
const { refreshKimiAccessToken } = require('./kimi-token-refresh');
const { createTokenRefreshDaemon } = require('./token-refresh-daemon');
const { createAccountActivity } = require('./account-activity');
const { createAccountSessionActivityPoller } = require('./account-session-activity');
const { createClineSessionOutcomePoller } = require('./cline-session-outcomes');
const { createKiroSessionOutcomePoller } = require('./kiro-session-outcomes');
const { createNodeAccountOutcomes } = require('./node-account-outcomes');
const { EgressPoolService } = require('../runtime/egress-pool-service');
const { setEgressPoolService } = require('../runtime/egress-pool-registry');
const { hasAnyEgressPoolBinding } = require('../account/zcode-egress-binding-store');
const { createEgressPoolPlanner } = require('./egress-pool-planner');
const { createEgressPoolMaintenance } = require('./egress-pool-maintenance');
const {
  configureEgressTrafficEvidence,
  createEgressTrafficEvidenceObserver
} = require('./egress-traffic-evidence');
const { recordUpstreamEvidence } = require('./egress-region-policy');
const { resolveAccountUpstream } = require('./egress-upstream');
const { configureGatewayNetworkGuard, listNetworkDeniedRefs } = require('./egress-network-guard-gateway');
const { EGRESS_POOL_PLAN_INTERVAL_MS } = require('../cli/config/constants');
const { handleManagementRequest } = require('./management-router');
const { attachGoProjection, getPluginSystem } = require('../plugins/control/plugin-system');
const { currentPluginSnapshot, explainPluginDeferral, pluginForwardingFor } = require('./gateway-plugin-stage');
const {
  applyProxyEnvironment,
  buildGoProxyEnvironment,
  explainGoProxyHandoff
} = require('./go-core-proxy-guard');
const { mergePluginAliases } = require('../plugins/gateway/catalog');
const { handleNodeRpcRequest } = require('./node-rpc-router');
const { handleFabricRequest } = require('./fabric-router');
const { authorizeWebUiRequest } = require('./webui-auth-gate');
const { handleAggregatedSubscriptionRequest } = require('./subscription-aggregator-public-route');
const { SESSION_WATCH_WEBSOCKET_PATH, createSessionWatchWebSocketServer } = require('./webui-session-watch-websocket');
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
  removeLiveAccountRecord,
  updateCachedAccountTokenUsage,
  emitAccountsLiveEvent,
  emitAccountTokenConsumedEvent,
  countAccountsWatchListeners
} = require('./webui-account-live');
const { withAccountQueryListFns } = require('./account-load-args');
const { startRuntimeRecoveryDaemon } = require('./runtime-recovery-daemon');
const { startServerSourceAutoRestart } = require('./source-auto-restart');
const { setServerRestartField } = require('./server-restart-context');
const {
  createProxyServerState,
  printProxyServeStartup
} = require('./server-runtime');
const { ensureWebUiModelRefreshScheduler } = require('./webui-model-refresh-scheduler');
const { createAccountQuotaProbeScheduler } = require('./account-quota-probe-scheduler');
const { createWindowActivationScheduler } = require('./window-activation-scheduler');
const { ensureWebUiModelsCacheLoaded } = require('./webui-model-cache');
const { buildModelAccountIndex, findModelsForAccount } = require('./model-account-index');
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
const { createCodexResetCreditService } = require('./codex-reset-credit-service');
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
const { getCodexClientVersion } = require('./codex-client-version');
const { DEFAULT_DRAIN_TIMEOUT_MS, createInferenceDrain } = require('./inference-drain');
const { createStartupTimeline } = require('./startup-timeline');
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
const { createPricingCatalogSourceStore } = require('../usage/pricing/catalog-source-store');
const { refreshCommunitySources } = require('../usage/pricing/community-sources');
const { createLayeredPricingProvider } = require('../usage/pricing-providers/catalog-layered');
const { createModelsDevPricingProvider } = require('../usage/pricing-providers/models-dev');
const { createModelUsageScanScheduler } = require('../usage/model-usage-scheduler');
const { createCodebuddyUsageRefresh } = require('../usage/codebuddy-usage-refresh');
const { createGrokUsageRefresh } = require('../usage/grok-usage-refresh');
const { createZcodeUsageRefresh } = require('../usage/zcode-usage-refresh');
const { createProviderCliUpgradeScheduler } = require('./provider-cli-upgrade-scheduler');
const { createProviderUpgradeDeps } = require('./provider-cli-upgrade/upgrade-deps');
const {
  startCodexSessionNotificationBridge
} = require('./codex-session-notification-queue');
const { defaultSessionEventBus } = require('./session-event-bus');
const { loadOrCreateServerIdentity } = require('./server-identity');
const { createOutboundRelayManager } = require('./outbound-relay-manager');
const { readOutboundRelayConfig } = require('./outbound-relay-config-store');
const {
  DEFAULT_FABRIC_GATEWAY_TIMEOUT_MS,
  proxyFabricGatewayRequest
} = require('./fabric-gateway-fallback');
const { buildFabricGatewayReadiness } = require('./fabric-gateway-capability');
const { explainGoRouteDeferral, needsRequestModel } = require('./go-core-route-deferral');
const { createAccountEgressBindingIndex } = require('./account-egress-binding-index');
const { proxyFabricGatewayWebSocket } = require('./fabric-gateway-websocket');
const { createGoCoreHost, resolveGoCoreSettings } = require('./go-core-host');
const { notifyGoCoreProjection } = require('./go-core-projection-sync');
const { createGoClaudeAuthRecovery } = require('./go-claude-auth-recovery');
const { createGoRuntimeOverlay } = require('./go-runtime-overlay');
const { createGoCredentialBlockRecovery } = require('./go-credential-block-recovery');
const { createGoUsageEventFeed } = require('./go-usage-event-feed');
const { handleCodexResponsesWebSocket } = require('./codex-responses-websocket');

// chat 模式大文档经 thread/inject_items 进入历史后，harness 每次请求都携带完整
// 历史：16MB 附件上限 + 关键帧 base64 + 既有对话，10MB 默认值会 413。
const DEFAULT_MAX_REQUEST_BODY_BYTES = 32 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 70_000;
const DEFAULT_HEADERS_TIMEOUT_MS = 75_000;
const DEFAULT_KEEP_ALIVE_TIMEOUT_MS = 5_000;
const DEFAULT_CODEX_CLI_HOOK_SELF_HEAL_INTERVAL_MS = 15_000;
const DEFAULT_CODEX_DESKTOP_HOOK_SELF_HEAL_INTERVAL_MS = 15_000;
// 停机环节计时的上报阈值：低于它的环节不打印，避免正常关闭刷屏。
const SHUTDOWN_STEP_LOG_THRESHOLD_MS = 500;

// Node 账号所属 Provider（按运行池查找）；Go 用量事件只带账号，入账需要 Provider。
function resolveAccountProvider(state, accountRef) {
  const ref = String(accountRef || '').trim();
  if (!ref) return '';
  for (const provider of SUPPORTED_SERVER_PROVIDERS) {
    const pool = state && state.accounts && Array.isArray(state.accounts[provider]) ? state.accounts[provider] : [];
    if (pool.some((account) => String(account && account.accountRef || '').trim() === ref)) return provider;
  }
  return '';
}

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
  const reconcileKimiHostCredentials = createKimiHostCredentialReconciler({
    fs,
    path,
    aiHomeDir,
    hostHomeDir
  });
  const loadRuntimeAccountsWithHostReconciliation = (loadArgs = {}) => loadRuntimeAccounts({
    ...loadArgs,
    reconcileKimiHostCredentials
  });
  const applyRuntimeReloadState = typeof deps.applyReloadState === 'function'
    ? deps.applyReloadState
    : applyReloadState;
  options = { ...options };
  // 监听之前的每一步都在推迟网关恢复服务。这里只计时、不改变顺序：哪些步骤值得挪到
  // 监听之后要由真实数据决定（例如自中转账号清理必须在账号进路由之前跑完，不能挪）。
  const startupTimeline = createStartupTimeline({ preludeSteps: options.startupPreludeSteps });
  const manageProcessLifecycle = options.manageProcessLifecycle !== false;
  let serverInstanceLock = null;
  let lifecycleStopping = false;

  // Standalone single-instance guard: refuse to become a second gateway on the
  // same port. `--allow-multi` is the explicit bypass (tests / intentional
  // multi-instance). The ~3s port grace lets a restarting predecessor finish
  // releasing the port before we give up.
  if (aiHomeDir && options.allowMulti !== true) {
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
        throw new Error(`another aih server is already running (pid=${serverInstanceLock.pid}); refusing to start a second instance. Use 'aih server restart', stop it first, or pass --allow-multi to override`);
      }
      throw new Error(`port ${options.port} is already in use (held on ${serverInstanceLock.host}); refusing to start a second gateway. Stop the other instance or pass --allow-multi to override`);
    }
  }

  startupTimeline.mark('instanceLock');
  const listenPort = await resolveListenPort(options.host, options.port);
  startupTimeline.mark('listenPort');
  if (listenPort.changed) {
    if (options.strictPort === true) {
      if (serverInstanceLock && typeof serverInstanceLock.release === 'function') serverInstanceLock.release();
      throw new Error(`port_in_use:${options.port}`);
    }
    console.warn(`\x1b[33m[aih]\x1b[0m port ${options.port} is in use; using ${listenPort.port}`);
    options.port = listenPort.port;
  }
  if (!String(options.codexClientVersion || '').trim()) {
    // 显式配置原样生效（人工锁定）；自动探测结果不低于编码器已验证的协议代。
    // 自动探测必须持续跟随本机 CLI：只在启动时算一次的话，CLI 自动升级后仍按旧版本拉
    // 模型目录，上游据 client_version 不下发新模型，要等服务重启才看得到。
    const detectCurrent = () => getCodexClientVersion({ processObj, resolveCliPath });
    options.codexClientVersion = detectCurrent();
    options.currentCodexClientVersion = detectCurrent;
  }
  startupTimeline.mark('codexClientVersion');
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
  // Go Core 宿主与「编辑即推送」入口（见 go-core-projection-sync）。两者都在装配期赋值，
  // 但账号运行事件监听器、宿主内部重载等路径先于装配就可能被触发，所以声明必须早于它们。
  let goCoreHost = null;
  let goCoreSync = null;
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
  const codexResetCreditService = deps.codexResetCreditService || createCodexResetCreditService({
    fs,
    aiHomeDir,
    getProfileDir,
    env: processObj.env,
    hostHomeDir,
    cwd: typeof processObj.cwd === 'function' ? processObj.cwd() : hostHomeDir,
    platform: processObj.platform,
    spawnImpl: spawn,
    spawnSyncImpl: spawnSync
  });

  startupTimeline.mark('coreWiring');
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
  startupTimeline.mark('deleteSelfRelayAccounts');

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
  startupTimeline.mark('pruneRuntimeProjections');

  try {
    const pruned = pruneStaleCodexAppServerStates({
      fs,
      path,
      aiHomeDir,
      accountStateIndex,
      spawnSyncImpl: spawnSync
    });
    if (pruned.removed > 0 || pruned.failed > 0) {
      console.log(`\x1b[36m[aih]\x1b[0m Codex app-server state prune: removed ${pruned.removed}, kept ${pruned.kept}, failed ${pruned.failed}`);
    }
  } catch (error) {
    console.warn(`\x1b[33m[aih]\x1b[0m Codex app-server state prune skipped: ${String((error && error.message) || error)}`);
  }
  startupTimeline.mark('pruneCodexAppServerStates');

  try {
    const restored = restoreManagedToolServices({ aiHomeDir, hostHomeDir, processObj });
    for (const item of restored.filter((entry) => entry.adopted || entry.restored)) {
      console.log(`\x1b[36m[aih]\x1b[0m toolkit service ${item.id}: ${item.adopted ? 'adopted' : 'restored'} pid ${item.pid}`);
    }
  } catch (error) {
    console.warn(`\x1b[33m[aih]\x1b[0m toolkit service restore skipped: ${String((error && error.message) || error)}`);
  }
  startupTimeline.mark('restoreToolServices');

  // 账号出口索引：Go Core 不执行账号出口，绑定了网关侧出口的账号请求必须交还 Node
  // （见 account-egress-binding-index）。state 建好后挂上去：WebUI 改绑定后立即 invalidate。
  const accountEgressBindingIndex = createAccountEgressBindingIndex({ fs, aiHomeDir });

  // 出口池：把用户代理池里的节点变成账号可绑定的本地出站端口（见 egress-pool-service）。
  // 它是增强能力 —— 缺内核/缺节点都只是打一行日志，不影响 server 本身与其它 provider。
  // 刻意不阻塞启动：内核冷启动要 1-3s，让它自己在后台就绪。
  const egressPool = (typeof deps.createEgressPoolService === 'function'
    ? deps.createEgressPoolService
    : (poolOptions) => new EgressPoolService(poolOptions))({
    fs,
    aiHomeDir,
    env: processObj.env,
    enabled: deps.enableEgressPool !== false,
    mixedPort: deps.egressPoolMixedPort,
    controllerPort: deps.egressPoolControllerPort,
    spawn: deps.spawn,
    getProxyNodeStore: deps.getProxyNodeStore,
    logger: (message) => console.log(`\x1b[36m[aih]\x1b[0m ${message}`)
  });
  if (egressPool.enabled !== false) {
    // 登记到进程内单例：请求热路径（transport 的 429 轮换）按需读取，
    // 不顺着 deps 透传 —— 少一层透传就少一处静默失效的机会（见 registry 模块头）。
    setEgressPoolService(egressPool);
    // 只在已有账号绑定 `pool` 时启动时拉起：没人用池就不在后台起一个用户没要的代理内核。
    // 之后新绑定的 `pool` 由请求解析时惰性拉起（registry.ensureEgressPoolStarted）。
    const poolBound = typeof deps.hasAnyEgressPoolBinding === 'function'
      ? deps.hasAnyEgressPoolBinding(fs, aiHomeDir)
      : hasAnyEgressPoolBinding(fs, aiHomeDir);
    if (poolBound) {
      Promise.resolve()
        .then(() => egressPool.start())
        .catch((error) => {
          console.warn(`\x1b[33m[aih]\x1b[0m egress pool skipped: ${String((error && error.message) || error)}`);
        });
    }
  }

  const logMaxBytes = resolveMaxBytes(processObj.env);
  const logMaxAgeMs = resolveMaxAgeMs(processObj.env);
  // Node 承接流量的账号结果桶：健康统计的第二路来源（见 node-account-outcomes 模块注释）。
  const nodeAccountOutcomes = createNodeAccountOutcomes({ fs, aiHomeDir });
  function appendProxyRequestLog(entry) {
    // 统一注入追踪字段：调用点不需要知道自己在哪个 span 里，
    // 由这里从异步上下文取当前 trace，日志就能读成一棵树。
    const traced = entry && typeof entry === 'object'
      ? { ...traceLogFields(), ...entry }
      : entry;
    appendBoundedJsonLine(fs, logFile, traced, { path, maxBytes: logMaxBytes });
    entry = traced;
    // 每次上游重试失败都带账号身份：记进结果桶，交还 Node 期间健康统计不再停摆。
    if (entry && entry.kind === 'account_retry_failure' && entry.accountRef) {
      const atMs = Date.parse(String(entry.at || ''));
      nodeAccountOutcomes.record({
        accountRef: entry.accountRef,
        outcome: entry.policyKind || entry.error || `http_${entry.status || 0}`,
        atMs: Number.isFinite(atMs) ? atMs : Date.now()
      });
    }
  }
  nodeAccountOutcomes.start();
  const composeChatRuntime = typeof deps.createChatRuntimeComposition === 'function'
    ? deps.createChatRuntimeComposition
    : createChatRuntimeComposition;
  const chatRuntimeService = createOptionalChatRuntime({
    fs, aiHomeDir, hostHomeDir, getProfileDir, ensureSessionStoreLinks, accountArtifactHooks,
    chatGateway: {
      port: options.port,
      clientKey: options.clientKey,
      isModelEnabled: createChatAccountModelPolicy(() => state),
      // canonical 原生驱动的默认模型：与 legacy 路由同一解析处（state 的模型缓存 / 注册表）。
      resolveDefaultModel: (provider, accountRef) => resolveProviderDefaultModel(provider, '', {
        state, accountRef
      }),
      // 账号运行态端口（延迟求值：hub/gate 在本函数稍后才创建）。引擎据此把 native session 的
      // 终端输出判定（auth_invalid / 上游拒用）写回账号，否则被拒账号会一直留在调度池里。
      getAccountRuntimePorts: () => ({
        accountRuntimeEventHub: accountRuntimeEvents,
        accountStateService,
        accountRuntimeGate
      }),
      readModels: createChatHarnessModelReader({
        getState: () => state, options, fs, aiHomeDir, accountStateService,
        fetchModelsForAccount: fetchModelsForAccountWithRefresh
      })
    },
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

  // 账号运行态的唯一出口：推理成功/失败、探测成功、恢复（登录/刷新/用量/native session）、
  // 人工强制恢复都走它。必须先于首次建池创建，否则启动时那一次池加载里的恢复路径只能
  // 退回直调账号状态服务。这里传 router 的**原始** applier（不是 *AndPersist 包装）——
  // 发布由门禁统一做，传包装会导致同一次失败被发布两遍。
  const accountRuntimeEvents = createAccountRuntimeEventHub({
    onError: (error, event) => {
      const msg = String((error && error.message) || error || 'unknown_error');
      const provider = String(event && event.provider || '').trim();
      const accountRef = String(event && event.accountRef || '').trim();
      console.warn(`\x1b[33m[aih:runtime-event]\x1b[0m ${provider}#${accountRef}: ${msg}`);
    }
  });
  const accountRuntimeGate = createAccountRuntimeGate({
    hub: accountRuntimeEvents,
    accountStateService,
    markProxyAccountFailure,
    markProxyAccountSuccess
  });
  startupTimeline.mark('runtimeComposition');
  const state = createProxyServerState(options, {
    loadServerRuntimeAccounts: loadRuntimeAccountsWithHostReconciliation,
    initProxyMetrics,
    createProviderExecutor,
    initModelRegistry,
    fs,
    aiHomeDir,
    accountStateIndex,
    accountStateService,
    accountRuntimeGate,
    accountQueryService,
    getToolConfigDir,
    getProfileDir,
    checkStatus
  });
  state.accountEgressBindingIndex = accountEgressBindingIndex;
  // 出口池车道：账号的节点范围 × 上游地区判定 → 车道（见 egress-pool-planner / egress-pool-maintenance）。
  const egressPoolPlanner = createEgressPoolPlanner({
    fs,
    aiHomeDir,
    env: processObj.env,
    getService: () => egressPool,
    getPools: () => (state && state.accounts) || {},
    getServerOptions: () => options,
    logger: (message) => console.log(`\x1b[36m[aih]\x1b[0m ${message}`)
  });
  const egressPoolMaintenance = createEgressPoolMaintenance({
    fs,
    aiHomeDir,
    planner: egressPoolPlanner,
    getService: () => egressPool,
    logger: (message) => console.warn(`\x1b[33m[aih]\x1b[0m ${message}`)
  });
  state.egressPoolPlanner = egressPoolPlanner;
  state.egressPoolMaintenance = egressPoolMaintenance;
  const egressPoolLanes = {
    timer: null,
    stop() {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      configureEgressTrafficEvidence(null);
      configureGatewayNetworkGuard(null);
    }
  };
  // 当前网络守卫（网关侧）：不走出口池的账号，实际出口被其上游按地区拒绝时 fail-closed。
  configureGatewayNetworkGuard({
    fs,
    aiHomeDir,
    getServerOptions: () => options,
    getPools: () => (state && state.accounts) || {},
    getAccount: (accountRef) => {
      const pools = (state && state.accounts) || {};
      for (const pool of Object.values(pools)) {
        const found = Array.isArray(pool) ? pool.find((item) => item && item.accountRef === accountRef) : null;
        if (found) return found;
      }
      return null;
    }
  });
  // 真实流量回写地区实测：车道节点被上游按地区拒绝 → 剔除并换节点；成功 → 记可用。
  configureEgressTrafficEvidence(createEgressTrafficEvidenceObserver({
    getService: () => egressPool,
    planner: egressPoolPlanner,
    resolveUpstream: (account) => resolveAccountUpstream(options, account),
    recordEvidence: (upstreamId, exitKey, entry) => recordUpstreamEvidence(fs, aiHomeDir, upstreamId, exitKey, entry),
    ttlMs: (upstream) => {
      const context = egressPoolPlanner.upstreamContext(upstream);
      return context && context.ttlMs;
    }
  }));
  if (egressPool.enabled !== false) {
    egressPool.planNow = () => egressPoolPlanner.planNow();
    const onPoolReady = () => {
      egressPoolPlanner.reconcile({ force: true, refreshCatalog: true });
      // 池刚就绪：一次性补全节点位置（之后每轮只补到期的），挂起的车道因此尽快有出口。
      egressPoolMaintenance.tick({ geoLimit: 1000, probeLimit: 20 }).catch(() => {});
    };
    if (typeof egressPool.setOnReady === 'function') egressPool.setOnReady(onPoolReady);
    if (egressPool.ready) onPoolReady();
    egressPoolLanes.timer = setInterval(() => {
      if (!egressPool.ready) return;
      egressPoolPlanner.reconcile();
      egressPoolMaintenance.tick().catch(() => {});
    }, EGRESS_POOL_PLAN_INTERVAL_MS);
    if (typeof egressPoolLanes.timer.unref === 'function') egressPoolLanes.timer.unref();
  }
  // 挂到 state 上：没有 ctx.deps 的深层调用方（模型目录刷新等）用 getAccountRuntimeGate(state) 取同一实例。
  state.accountRuntimeEventHub = accountRuntimeEvents;
  state.accountRuntimeGate = accountRuntimeGate;
  ensureWebUiModelsCacheLoaded(state, { fs, aiHomeDir });
  state.modelAccountIndex = buildModelAccountIndex(state, options);
  startupTimeline.mark('loadAccountsAndModelIndex');
  // 翻译页的模型目录是派生视图（能力索引 + 别名 + 可用账号），首次构建实测约 0.9s。
  // 在 listen 之前预热，让第一个打开翻译页的请求只做内存读取；不放请求路径上重算。
  try {
    const { warmTranslationModelCatalog } = require('./webui-translation-routes');
    warmTranslationModelCatalog({ state, options, fs, aiHomeDir, deps: {} });
  } catch (_translationWarmError) {
    // 预热失败不影响启动：首个请求会自行构建（stale-while-revalidate 继续兜底）。
  }
  startupTimeline.mark('translationModelCatalog');
  const accountActivity = createAccountActivity();
  state.accountActivity = accountActivity;
  // in-use 捕获的第三条来源：aih 托管的持久 CLI 会话（所有 provider 通用，
  // 不依赖 provider hook）。见 account-session-activity 模块注释。
  const accountSessionActivityPoller = createAccountSessionActivityPoller({
    fs,
    aiHomeDir,
    accountActivity
  });
  state.accountSessionActivityPoller = accountSessionActivityPoller;
  // 健康统计的第三个来源：原生 CLI 会话终态（cline 会话 status、kiro 每轮 usage_summary）→ 账号结果桶。
  // CLI-only 账号没有上游 attempt，这是它唯一可观测的结果证据；模板见 native-session-outcome-poller.js。
  const nativeSessionOutcomePollers = [createClineSessionOutcomePoller, createKiroSessionOutcomePoller]
    .map((createPoller) => createPoller({ fs, aiHomeDir, hostHomeDir, nodeAccountOutcomes }));
  // P5：官方/社区价格快照是 models.dev 的覆盖层；插件采集写快照，计价仍由宿主做。
  const pricingSourceStore = createPricingCatalogSourceStore({ fs, aiHomeDir });
  const modelUsageService = createModelUsageService({
    fs,
    path,
    aiHomeDir,
    hostHomeDir,
    fetchImpl,
    modelsDevPricingProvider: createLayeredPricingProvider(
      createModelsDevPricingProvider(),
      { store: pricingSourceStore }
    )
  });
  const imageStudioStore = createImageStudioStore({ fs, aiHomeDir });
  const recordModelUsageWithEvents = (payload) => {
    const recorded = modelUsageService.recordApiUsage(payload);
    if (recorded > 0) {
      // 成功记账即一次成功结果：Go 承接时由 Go 记，Node 承接时由这里补上（否则交还期间统计缺成功样本）。
      nodeAccountOutcomes.record({
        accountRef: payload && payload.accountRef,
        outcome: 'success',
        atMs: Number(payload && payload.timestampMs) || Date.now()
      });
      try {
        emitAccountTokenConsumedEvent(state, payload);
      } catch (_error) {
        // best-effort real-time event; never fail the accounting path
      }
    }
    return recorded;
  };
  const modelUsageScanScheduler = createModelUsageScanScheduler({
    modelUsageService,
    onTokenUsageUpdated: (usageByAccount, cacheOptions) => updateCachedAccountTokenUsage({
      state,
      fs,
      aiHomeDir
    }, usageByAccount, cacheOptions),
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
  const grokUsageRefresh = createGrokUsageRefresh({
    sessionEventBus: defaultSessionEventBus,
    modelUsageService,
    enabled: options.modelUsageScan !== false,
    onTokenUsageUpdated: (usageByAccount, cacheOptions) => updateCachedAccountTokenUsage({
      state, fs, aiHomeDir
    }, usageByAccount, cacheOptions),
    logWarn: (msg) => console.warn(`[aih:model-usage] ${msg}`)
  });
  const codebuddyUsageRefresh = createCodebuddyUsageRefresh({
    fs, hostHomeDir, aiHomeDir,
    sessionEventBus: defaultSessionEventBus, modelUsageService,
    enabled: options.modelUsageScan !== false,
    onTokenUsageUpdated: (usageByAccount, cacheOptions) => updateCachedAccountTokenUsage({
      state, fs, aiHomeDir
    }, usageByAccount, cacheOptions),
    logWarn: (msg) => console.warn(`[aih:model-usage] ${msg}`)
  });
  const zcodeUsageRefresh = createZcodeUsageRefresh({
    fs, hostHomeDir, aiHomeDir,
    sessionEventBus: defaultSessionEventBus, modelUsageService,
    enabled: options.modelUsageScan !== false,
    onTokenUsageUpdated: (usageByAccount, cacheOptions) => updateCachedAccountTokenUsage({
      state, fs, aiHomeDir
    }, usageByAccount, cacheOptions),
    logWarn: (msg) => console.warn(`[aih:model-usage] ${msg}`)
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

  const unregisterAccountRuntimeListeners = registerAccountRuntimeEventListeners(accountRuntimeEvents, {
    state,
    options,
    fs,
    aiHomeDir,
    accountStateIndex,
    accountStateService,
    accountRuntimeGate,
    accountQueryService,
    loadServerRuntimeAccounts: loadRuntimeAccountsWithHostReconciliation,
    applyReloadState: applyRuntimeReloadState,
    // 装配期 goCoreSync 还是 null，用 getter 读装配后的实例（监听器只在运行期触发）。
    get goCoreSync() { return goCoreSync; },
    getToolConfigDir,
    getProfileDir,
    checkStatus
  });
  const accountRuntimeEventPublisher = createAccountRuntimeEventPublisher(accountRuntimeEvents);

  function reloadRuntimeAccountsForLiveDelete() {
    if (typeof loadRuntimeAccounts !== 'function' || typeof applyRuntimeReloadState !== 'function') {
      return false;
    }
    const runtimeAccounts = loadRuntimeAccountsWithHostReconciliation(withAccountQueryListFns({
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
    // 账号被删除/凭据变化后运行池会变，规则投影随之改变（见 go-core-projection-sync）。
    notifyGoCoreProjection({ goCoreSync }, 'upstreamErrorRules');
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

  const recoverClaudeLogin = createClaudeLoginRecovery({
    fs, aiHomeDir, hostHomeDir, accountStateIndex, accountStateService, accountRuntimeGate, processObj
  });

  function recoverClaudeLoginWithEvents(account) {
    const result = recoverClaudeLogin(account);
    if (result.recovered) {
      accountRuntimeEventPublisher.publishChanged(account, 'auth_invalid', 'server.claude.login_recovery');
    }
    return result;
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

  function refreshGrokAccessTokenWithHooks(account, refreshOptions = {}, refreshDeps = {}) {
    return refreshGrokAccessToken(account, refreshOptions, {
      ...refreshDeps,
      fs,
      aiHomeDir,
      accountArtifactHooks
    });
  }

  function refreshKimiAccessTokenWithHooks(account, refreshOptions = {}, refreshDeps = {}) {
    return refreshKimiAccessToken(account, refreshOptions, {
      ...refreshDeps,
      fs,
      aiHomeDir,
      hostHomeDir,
      reconcileHostCredentials: reconcileKimiHostCredentials,
      accountArtifactHooks
    });
  }

  async function fetchModelsForAccountWithRefresh(modelOptions, account, timeoutMs = 8000) {
    if (
      account
      && String(account.provider || '').trim().toLowerCase() === 'kimi'
      && !account.apiKeyMode
      && String(account.authType || '').trim().toLowerCase() !== 'api-key'
    ) {
      try {
        await refreshKimiAccessTokenWithHooks(account, {
          force: false,
          skewMs: Math.max(30_000, Number(options.tokenStartupRefreshBeforeExpiryMs) || 5 * 60 * 1000),
          timeoutMs: Math.max(2_000, Number(timeoutMs) || options.upstreamTimeoutMs),
          proxyUrl: options.proxyUrl,
          noProxy: options.noProxy
        }, { fetchWithTimeout });
      } catch (_error) {}
    }
    return fetchModelsForAccount(modelOptions, account, timeoutMs);
  }

  const requiredClientKey = String(options.clientKey || '').trim();
  const readGoCoreServerConfig = () => {
    try { return readServerConfig({ fs, aiHomeDir }); } catch (_error) { return {}; }
  };
  // Go 子进程走 Node 生效的同一个出站代理（Go 只读标准代理变量）；转发前判定拿它比对。
  const goProxyEnvironment = buildGoProxyEnvironment({
    proxyUrl: options.proxyUrl,
    noProxy: options.noProxy,
    env: (processObj && processObj.env) || {}
  });
  const goChildProxyEnv = applyProxyEnvironment((processObj && processObj.env) || {}, goProxyEnvironment);
  const goClaudeAuthRecovery = createGoClaudeAuthRecovery({
    fs,
    aiHomeDir,
    refreshClaudeAccessToken: (account, refreshOptions) => {
      const accountRef = String(account && account.accountRef || '').trim();
      const current = Array.isArray(state.accounts && state.accounts.claude)
        ? state.accounts.claude.find((item) => String(item && item.accountRef || '').trim() === accountRef)
        : null;
      return refreshClaudeAccessTokenWithHooks(
        current || { provider: 'claude', accountRef },
        {
          ...refreshOptions,
          proxyUrl: options.proxyUrl,
          noProxy: options.noProxy
        },
        { fetchWithTimeout }
      );
    },
    onCredentialUpdated: async () => {
      try { reloadRuntimeAccountsForLiveDelete(); } catch (_error) {}
      if (!goCoreHost || typeof goCoreHost.reconcileAccounts !== 'function') return false;
      const result = await goCoreHost.reconcileAccounts();
      return Boolean(result && result.failed !== true && !result.skipped);
    }
  });
  goCoreHost = (typeof deps.createGoCoreHost === 'function' ? deps.createGoCoreHost : createGoCoreHost)({
    settings: resolveGoCoreSettings(readGoCoreServerConfig(), (processObj && processObj.env) || {}),
    fs,
    spawn,
    fetchImpl,
    processObj,
    childEnvironment: goProxyEnvironment,
    http,
    aiHomeDir,
    // 账号自定义上游错误规则的投影来源：运行池里的有效规则（账号直接规则 + 命中分组规则）。
    accountPools: () => (state && state.accounts) || {},
    publicPort: options.port,
    requiredClientKey,
    writeJson,
    needsRequestModel,
    maxRequestBodyBytes: Math.max(1024, Number(options.maxRequestBodyBytes) || DEFAULT_MAX_REQUEST_BODY_BYTES),
    recoverClaudeAuth: (input = {}) => {
      const directRef = String(input.accountRef || '').trim();
      const servedRef = String(input.servedAccountRef || '').trim();
      let accountRef = directRef;
      if (!accountRef && goCoreHost && typeof goCoreHost.nodeAccountRefFor === 'function') {
        accountRef = goCoreHost.nodeAccountRefFor(servedRef);
      }
      return goClaudeAuthRecovery.recover({ ...input, accountRef });
    },
    // 插件：Go 只承接已确认代次的 gateway.request；转发时由 Node 固定代次并带代次头。
    pluginForwarding: () => pluginForwardingFor(state),
    deferToNode: ({ entryId, pinnedAccountRef, model, pathname, transport, explicitProvider, modelNamespace, forceNode }) => {
      // G5：每次交还 Node 都按原因计数（随 /readyz 暴露）。转发器只读布尔值，
      // 原因经 record 旁路登记——WebSocket 升级路径用 `=== true` 严格比较，返回值形态不能变。
      const record = (reason) => {
        if (typeof goCoreHost.recordNodeFallback === 'function') goCoreHost.recordNodeFallback(reason);
        return true;
      };
      const decide = (decision) => (decision.defer ? record(decision.reason) : false);
      // 客户端显式要求由 Node 完整实现（跨 Provider harness 的启动器注入）：不转发、
      // 不参与插件代次与出口判定，直接交给 Node 的完整协议实现。
      if (forceNode === true) return record('route_owner_node');
      // Go 只认标准代理环境变量：启动时已把 Node 生效的代理写进 Go 的环境，这里再确认两边
      // 仍是同一个出口；不一致时交还 Node，避免 Go 绕过代理直连泄漏出口 IP。
      const proxy = explainGoProxyHandoff({
        proxyUrl: options.proxyUrl,
        noProxy: options.noProxy,
        env: goChildProxyEnv
      });
      if (proxy.defer) return decide(proxy);
      // Go 尚未支持的插件阶段（account / attempt / observe、WebSocket、其它入口）或 Go 未确认当前代次时交回 Node。
      const plugin = explainPluginDeferral(state, { entryId, transport });
      if (plugin.defer) return decide(plugin);
      const input = {
        entryId,
        pinnedAccountRef,
        explicitProvider,
        modelNamespace,
        model,
        pathname,
        state,
        accountStateIndex,
        fabricGatewayReady: () => buildFabricGatewayReadiness(fabricBrokerSessionRegistry).ready,
        goRoutableModelIds: () => goCoreHost.routableModelIds(),
        // Go 已确认接受的别名 id：命中的别名请求交给 Go，其余继续交还 Node。
        goAcceptedAliasIds: () => goCoreHost.acceptedAliasIds(),
        // Go 已确认承接规则的账号引用：未被承接的账号仍由 Node 执行自定义错误规则。
        goAcceptedErrorRuleRefs: () => goCoreHost.acceptedUpstreamErrorRuleRefs(),
        goAccountRefFor: (ref) => goCoreHost.goAccountRefFor(ref),
        goModelOwner: (id) => goCoreHost.routableModelOwner(id),
        // 绑定了网关侧出口的账号：Go 不执行账号出口，这些账号的请求交还 Node（见 account-egress-binding-index）。
        // 出口绑定的账号 ∪ 当前网络被上游按地区拒绝的账号：都必须由 Node 承接（Go 没有出口与网络守卫）。
        egressBoundRefs: () => {
          const bound = accountEgressBindingIndex.refs();
          if (!bound) return null;
          const denied = listNetworkDeniedRefs();
          return denied.size ? new Set([...bound, ...denied]) : bound;
        }
      };
      // 共存期间 Node 仍是完整实现：Go 暂不可用（重启窗口等）时请求尚未转出，交由 Node 处理，
      // 不再失败关闭成 503。
      if (!goCoreHost.isForwardingAvailable()) return record('go_not_forwarding');
      // 无模型（WebSocket 升级）时同步判定；有模型时读 Node 别名表再判定。
      if (!model) return decide(explainGoRouteDeferral(input));
      return Promise.resolve(loadAliases(fs, aiHomeDir))
        // 插件代次声明的别名同样只有 Node 认识：并进别名表一起判定。
        .then((data) => decide(explainGoRouteDeferral({
          ...input,
          aliases: mergePluginAliases(data && data.aliases, currentPluginSnapshot(state))
        })))
        // 别名表读不出来时保守交还 Node，而不是冒险让 Go 丢掉别名语义。
        .catch(() => record('alias_table_unreadable'));
    }
  });
  // 账号页调度状态叠加 Go 运行态（Go 承接流量的冷却 / 熔断 / 最近成功），由账号 watch 轮询刷新。
  state.goRuntimeOverlay = createGoRuntimeOverlay({
    listAccountRuntime: () => (typeof goCoreHost.listAccountRuntime === 'function'
      ? goCoreHost.listAccountRuntime()
      : Promise.resolve(null)),
    readGoRefsByNodeRef: () => (typeof goCoreHost.goRefsByNodeRef === 'function'
      ? goCoreHost.goRefsByNodeRef()
      : null)
  });
  // Go 承接流量的 token 用量：增量拉取后走与 Node 转发同一记账入口（写库 + 实时推送）。
  const goUsageEventFeed = createGoUsageEventFeed({
    listUsageEvents: (afterSeq) => (typeof goCoreHost.listAccountUsageEvents === 'function'
      ? goCoreHost.listAccountUsageEvents(afterSeq)
      : Promise.resolve(null)),
    readGoRefsByNodeRef: () => (typeof goCoreHost.goRefsByNodeRef === 'function'
      ? goCoreHost.goRefsByNodeRef()
      : null),
    resolveProvider: (nodeRef) => resolveAccountProvider(state, nodeRef),
    recordUsage: recordModelUsageWithEvents
  });
  // Go 拒收 codex 凭据(401)后自身不刷新 token;交给 Node 的认证修复器刷新并推回 Go 解封。
  const goCredentialBlockRecovery = createGoCredentialBlockRecovery({
    listAccountRuntime: () => (typeof goCoreHost.listAccountRuntime === 'function'
      ? goCoreHost.listAccountRuntime()
      : Promise.resolve(null)),
    readGoRefsByNodeRef: () => (typeof goCoreHost.goRefsByNodeRef === 'function'
      ? goCoreHost.goRefsByNodeRef()
      : null),
    resolveProvider: (nodeRef) => resolveAccountProvider(state, nodeRef),
    reconciler: codexAuthInvalidReconciler
  });
  const managementKeyRotation = createManagementKeyRotationService({
    initialManagementKey: options.managementKey,
    managementKeySource: options.managementKeySource,
    writeServerConfig: (config) => writeServerConfig(config, { fs, aiHomeDir })
  });
  const cooldownMs = Math.max(1000, Number(options.cooldownMs) || 60000);
  const maxRequestBodyBytes = Math.max(1024, Number(options.maxRequestBodyBytes) || DEFAULT_MAX_REQUEST_BODY_BYTES);
  const codexAppServerProxy = createCodexAppServerProxy({
    fs,
    spawn,
    processObj,
    path,
    resolveCliPath,
    aiHomeDir,
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
  // 编辑即推送的统一入口（见 go-core-projection-sync）：WebUI deps 与宿主内部路径共用同一份。
  goCoreSync = {
    pushModelAliases: () => goCoreHost.pushModelAliases(),
    pushUpstreamErrorRules: () => goCoreHost.pushUpstreamErrorRules()
  };
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

  // Provider CLI 自动升级。构造点必须在 codexCliHookService 之后：standalone 安装脚本会把
  // aih 的 CLI hook 垫片覆盖掉，善后动作要拿得到真正的重装实现；server 没接管 hook 时不注入，
  // runPostInstallActions 才会把它当「跳过」而不是「失败」。
  const providerCliUpgradeScheduler = createProviderCliUpgradeScheduler({
    fs,
    path,
    processObj,
    aiHomeDir,
    deps: createProviderUpgradeDeps({
      fs,
      path,
      processObj,
      aiHomeDir,
      hostHomeDir,
      resolveCliPath,
      // Hook 存活核对要���同一份接收地址与发送脚本，否则「装回去」写的是别的 URL。
      providerHookReceiverUrl,
      providerHookSenderScriptPath: options.providerHookSenderScriptPath,
      codexClientVersion: options.codexClientVersion,
      reinstallCodexCliHook: codexCliHookService
        ? async () => codexCliHookService.ensureInstalled()
        : undefined,
      log: (entry) => {
        if (options.verbose || options.debug) {
          console.log(`\x1b[90m[aih:cli-upgrade]\x1b[0m ${JSON.stringify(entry)}`);
        }
      }
    }),
    config: {
      enabled: options.providerCliAutoUpgrade !== false,
      applyEnabled: options.providerCliAutoUpgradeApply !== false,
      startDelayMs: options.providerCliAutoUpgradeStartDelayMs,
      intervalMs: options.providerCliAutoUpgradeIntervalMs
    },
    logInfo: (msg) => {
      if (options.verbose || options.debug) {
        console.log(`\x1b[90m[aih:cli-upgrade]\x1b[0m ${msg}`);
      }
    },
    logWarn: (msg) => {
      console.warn(`\x1b[33m[aih:cli-upgrade]\x1b[0m ${msg}`);
    }
  });

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
      ensureInstalled: () => codexCliHookService.ensureInstalled({ background: true }),
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
          || hookResult && (hookResult.helperScriptChanged || hookResult.restartRequired)
        )
        && typeof codexDesktopHookService.restartRunningAppServers === 'function'
      ) {
        if (
          (hookResult && hookResult.restartRequired)
          || options.codexDesktopRestartAppServerOnHookChange === true
        ) {
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
            || result && (result.helperScriptChanged || result.restartRequired)
          )
          && typeof codexDesktopHookService.restartRunningAppServers === 'function'
          && (
            (result && result.restartRequired)
            || options.codexDesktopRestartAppServerOnHookChange === true
          )
        ) {
          codexDesktopHookService.restartRunningAppServers();
        }
        console.log(`\x1b[36m[aih:codex-hook]\x1b[0m repaired desktop hook at ${String(result.targetBinaryPath || '').trim()}`);
      },
      onFailure: (failure) => reportHookSelfHealFailure('codex-hook', failure)
    })
    : null;

  // 窗口激活调度器：构造点在 listen 之后（baseUrl 要实际端口），而 WebUI deps 需要在
  // 请求期读到它的运行态。用可变引用避免 TDZ —— deps 里的取值函数只在请求到达时执行。
  let windowActivationScheduler = null;

  function buildWebUiDeps() {
    return {
      // 账号页状态条：Go 账号结果时间桶 + Node 承接流量的结果桶 + Node→Go 账号映射。
      listGoAccountOutcomes: (granularity, fromMs) => goCoreHost.listAccountOutcomes(granularity, fromMs),
      listNodeAccountOutcomes: (granularity, fromMs) => nodeAccountOutcomes.list(granularity, fromMs),
      // provider hook 回合终态也写进结果桶（CLI-only 账号的健康统计来源）。
      nodeAccountOutcomes,
      goAccountRefFor: (ref) => goCoreHost.goAccountRefFor(ref),
      // WebUI 编辑后立刻把别名表/规则表推给 Go，不等兜底定时器（见 go-core-projection-sync）。
      goCoreSync,
      fs,
      writeJson,
      readRequestBody,
      spawnImpl: deps.spawn,
      accountStateIndex,
      accountStateService,
      accountActivity,
      accountRuntimeEventHub: accountRuntimeEvents,
      // 统一门禁：账号运行态的唯一入口（推理成功/失败 / 探测成功恢复 / 人工强制恢复）。
      accountRuntimeGate,
      accountQueryService,
      codexResetCreditService,
      getToolConfigDir,
      getProfileDir,
      loadServerRuntimeAccounts: loadRuntimeAccountsWithHostReconciliation,
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
      providerCliUpgradeScheduler,
      // 窗口激活的「当前生效」全局状态（弹窗用它判断逐账号开关是否真的会探测）。
      getWindowActivationState: () => (windowActivationScheduler ? windowActivationScheduler.getState() : null),
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
      imageStudioStore,
      chooseServerAccount: chooseServerAccountWithRuntimeSync,
      markProxyAccountSuccess: markProxyAccountSuccessAndPersist,
      markProxyAccountFailure: markProxyAccountFailureAndPersist,
      pushMetricError,
      appendProxyRequestLog,
      fetchModelsForAccount: fetchModelsForAccountWithRefresh,
      fetchWithTimeout,
      fetchGeminiCodeAssistGenerateContent,
      refreshCodexAccessToken: refreshCodexAccessTokenWithHooks,
      refreshAgyAccessToken: refreshAgyAccessTokenWithHooks,
      refreshGrokAccessToken: refreshGrokAccessTokenWithHooks,
      recordModelUsage: recordModelUsageWithEvents,
      buildManagementStatusPayload,
      buildManagementMetricsPayload,
      buildManagementAccountsPayload,
      modelUsageService,
      onTokenUsageUpdated: (usageByAccount, cacheOptions) => updateCachedAccountTokenUsage({
        state,
        fs,
        aiHomeDir
      }, usageByAccount, cacheOptions),
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
      outboundRelayManager,
      restartServerWithStoredConfig: async () => {
        const config = readServerConfig({ fs, aiHomeDir });
        const child = spawn(nodeExecPath || process.execPath, [entryFilePath, 'server', 'restart'], {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
          env: {
            ...(processObj.env || process.env),
            ...setServerRestartField({}, 'mode', 'background')
          }
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

  // 关机时先排空在途推理请求再停 Go Core，见 inference-drain.js。
  const inferenceDrain = createInferenceDrain();
  const sessionWatchWebSockets = createSessionWatchWebSocketServer({
    fs, aiHomeDir, hostHomeDir, sessionEventBus,
    getRequiredManagementKey: () => managementKeyRotation.getRequiredManagementKey()
  });
  const server = http.createServer((req, res) => {
    const requestId = createRequestId();
    // 本次客户端请求的追踪上下文：内部所有上游尝试 / 兜底 / 子调用都会继承它，
    // 于是日志能读成一棵树（哪个请求触发了哪些下游请求），而不是一堆并列的行。
    // 只影响日志字段，不改变任何业务行为。
    runWithTrace({ traceId: requestId, route: String(req.url || '') }, () => handleRequest(req, res, requestId));
  });

  async function handleRequest(req, res, requestId) {
    const startedAt = Date.now();
    const clientIp = requestClientIp(req);
    res.setHeader('x-aih-request-id', requestId);
    // 本请求的根 span 身份：access 日志在 res 'finish' 回调里写，那时异步上下文
    // 可能已经切走（例如停在最后一次上游尝试里），所以身份在这里就固定下来，
    // 保证「同一个客户端请求」的每条日志都指向同一个根 span。
    const rootSpan = currentTrace();

    const method = String(req.method || 'GET').toUpperCase();
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    let pathname = url.pathname || '/';
    inferenceDrain.track(pathname, res);
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
        clientIp,
        // 根 span 固定值：不随写日志那一刻的异步上下文漂移。
        // spanLabel 必须显式清空 —— 这条日志在 res 'finish' 时写，那时上下文
        // 可能停在最后一次上游尝试里，不清就会给根日志挂上 "attempt:N" 的标签。
        ...(rootSpan
          ? {
              traceId: rootSpan.traceId,
              spanId: rootSpan.spanId,
              spanDepth: rootSpan.depth || 0,
              spanLabel: undefined,
              parentSpanId: undefined
            }
          : {})
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
        const goCore = typeof goCoreHost.readiness === 'function' ? await goCoreHost.readiness() : null;
        return writeJson(res, 200, {
          ok: true,
          service: 'aih-server',
          ready: (Object.values(accounts).some((count) => count > 0) || gateway.ready)
            && (!goCore || goCore.ready),
          accounts,
          gateway,
          ...(goCore ? { go_core: goCore } : {})
        });
      }

      // 聚合订阅链接：客户端只带链接里的 token，不经 WebUI 鉴权门。
      if (await handleAggregatedSubscriptionRequest({ req, res, method, pathname, url })) return;

      if (pathname === '/v0/webui' || pathname.startsWith('/v0/webui/')) {
        // WebUI 数据面鉴权门：所有客户端（包括 loopback）统一使用 Management Key。
        const gate = authorizeWebUiRequest({ req, url, requiredManagementKey, deps: { fs, aiHomeDir } });
        if (!gate.ok) {
          return writeJson(res, gate.statusCode || 401, { ok: false, error: gate.error || 'webui_unauthorized' });
        }
        // R1 薄壳：若请求指向另一台已配置 server，本地 server 透明转发到该 server 的 /v0/webui/*，
        // 完整功能跟随当前 server（等价 workspace 迁到另一台电脑）。
        const proxyTarget = resolveProxyTarget({ req, requestHost: req.headers.host, deps: { fs, aiHomeDir } });
        if (proxyTarget && proxyTarget.error) {
          return writeJson(res, proxyTarget.statusCode || 404, {
            ok: false,
            error: proxyTarget.error,
            profileId: proxyTarget.profileId
          });
        }
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
        cooldownMs,
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
          loadServerRuntimeAccounts: loadRuntimeAccountsWithHostReconciliation,
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
          loadServerRuntimeAccounts: loadRuntimeAccountsWithHostReconciliation,
          applyReloadState: applyRuntimeReloadState,
          // /v0/management/reload 会重载运行池：池变即推送（见 go-core-projection-sync）。
          goCoreSync,
          fetchModelsForAccount: fetchModelsForAccountWithRefresh,
          getRegistryModelList,
          accountStateIndex,
          accountStateService,
          accountRuntimeGate,
          accountQueryService,
          fs,
          aiHomeDir,
          getToolConfigDir,
          getProfileDir,
          checkStatus,
          readRequestBody,
          modelUsageService,
          onTokenUsageUpdated: (usageByAccount, cacheOptions) => updateCachedAccountTokenUsage({
            state,
            fs,
            aiHomeDir
          }, usageByAccount, cacheOptions)
        }
      });
      if (handledManagement) return;

      // 已划给 Go Core 的数据面路由在 Node 选号/协议转换之前整条转发，失败关闭、不回退 Node。
      if (await goCoreHost.tryHandleHttp(req, res, { method, pathname, requestId })) return;

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
          recoverClaudeLogin: recoverClaudeLoginWithEvents,
          chooseServerAccount: chooseServerAccountWithRuntimeSync,
          // 推理路径（upstream-endpoints / codex-adapter / 图像生成）也走统一门禁。
          accountRuntimeGate,
          markProxyAccountSuccess: markProxyAccountSuccessAndPersist,
          markProxyAccountFailure: markProxyAccountFailureAndPersist,
          pushMetricError,
          appendProxyRequestLog,
          handleUpstreamModels,
          handleUpstreamPassthrough,
          handleCodexModels,
          handleCodexChatCompletions,
          handleImageGenerations,
          fetchModelsForAccount: fetchModelsForAccountWithRefresh,
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
          refreshGrokAccessToken: refreshGrokAccessTokenWithHooks,
          refreshKimiAccessToken: refreshKimiAccessTokenWithHooks,
          recordModelUsage: recordModelUsageWithEvents,
          accountActivity,
          proxyFabricGatewayRequest,
          fabricBrokerSessionRegistry,
          accountStateIndex,
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
  }
  let resolveClosed;
  const closed = new Promise((resolve) => {
    resolveClosed = resolve;
  });
  // 中转「跟随 AIH 端口」时（relay settings 的 portMode=server，默认），监听口交给分流器：
  // 首字节 0x05 的连接按 SOCKS5 处理（用户名 = 节点），其余照旧交给这个 http server。
  // 于是中转不需要任何额外端口；分流器关闭时 listener 就是 http server 本身。
  // UDP 前端（SOCKS5 UDP ASSOCIATE）在监听之后再绑：它要用**同一个端口号**的 UDP 侧。
  let relayUdpFront = null;
  const relayMux = createRelayPortMux({
    httpServer: server,
    resolveUdpFront: () => relayUdpFront,
    resolveRelay: () => {
      try {
        const { getLocalRelay } = require('../cli/services/toolkit/subscription-aggregator/relay/local-relay');
        return getLocalRelay().muxConfig();
      } catch (_error) {
        return { enabled: false, password: '', portForUser: () => 0 };
      }
    }
  });
  const listener = relayMux.enabled() ? relayMux.listener() : server;
  listener.once('close', () => resolveClosed());
  server.requestTimeout = Math.max(1000, Number(options.requestTimeoutMs) || DEFAULT_REQUEST_TIMEOUT_MS);
  server.headersTimeout = Math.max(1000, Number(options.headersTimeoutMs) || DEFAULT_HEADERS_TIMEOUT_MS);
  server.keepAliveTimeout = Math.max(1000, Number(options.keepAliveTimeoutMs) || DEFAULT_KEEP_ALIVE_TIMEOUT_MS);
  const runtimeRecovery = startRuntimeRecoveryDaemon(state, {
    intervalMs: Number(options.runtimeRecoveryIntervalMs) || 15000
  });
  // 账号活动快照落盘：CLI `aih ls` / `aih <provider> ls` 同机直读，驱动运行中
  // 账号的转圈指示。原子写（tmp + rename），1s 周期足够覆盖 10s 速率窗口。
  const accountActivityFlush = setInterval(() => {
    try {
      const snapshot = state.accountActivity && typeof state.accountActivity.snapshot === 'function'
        ? state.accountActivity.snapshot()
        : {};
      const runDir = path.join(aiHomeDir, 'run');
      if (!fs.existsSync(runDir)) fs.mkdirSync(runDir, { recursive: true });
      const target = path.join(runDir, 'account-activity.json');
      writeFileAtomic(fs, target, JSON.stringify({ updatedAt: Date.now(), accounts: snapshot }));
    } catch (_error) {
      // 落盘失败不影响网关主流程。
    }
  }, 1000);
  if (typeof accountActivityFlush.unref === 'function') accountActivityFlush.unref();
  // 持久 CLI 会话 → 账号 in-use：与快照落盘同时机启动（此刻才真正开始对外服务）。
  accountSessionActivityPoller.start();
  nativeSessionOutcomePollers.forEach((poller) => poller.start());
  let sourceAutoRestart = null;

  startupTimeline.mark('assembly');
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(options.port, options.host, resolve);
  });
  startupTimeline.mark('listen');
  // 网关从这一刻起恢复服务：重启的停机时长 = 旧实例停机 + 这一行的进程运行时长。
  console.log(`\x1b[90m[aih:startup]\x1b[0m ${startupTimeline.format()}`);
  // 翻译冷启动预热：服务已能响应后再发一个极小的后台请求，把保存的翻译模型所在账号
  // 的上游会话焐热。不阻塞启动、不影响首屏；失败只会在后台静默放弃。
  try {
    const listenAddress = listener.address();
    const listenPort = listenAddress && typeof listenAddress === 'object' ? listenAddress.port : options.port;
    const translationWarmupTimer = setTimeout(() => {
      try {
        const { warmTranslationGateway } = require('./webui-translation-routes');
        warmTranslationGateway({
          state,
          options: { ...options, port: listenPort, clientKey: requiredClientKey },
          fs,
          aiHomeDir,
          deps: {}
        });
      } catch (_translationWarmupError) {
        // 预热失败不影响服务；第一个真实请求仍会自行完成初始化。
      }
    }, 1200);
    if (typeof translationWarmupTimer.unref === 'function') translationWarmupTimer.unref();
  } catch (_translationWarmupScheduleError) {
    // ignore
  }
  // 同一个端口号的 UDP 侧：UDP relay 需要一个**固定**端口（边车给的是临时端口，防火墙放行不了）。
  // 绑不上（端口被占/权限）就保持 TCP-only，不阻塞服务启动。
  if (relayMux.enabled()) {
    const boundAddress = listener.address();
    const udpPort = boundAddress && typeof boundAddress === 'object' ? boundAddress.port : options.port;
    const { createRelayUdpFront } = require('./relay-udp-front');
    const front = createRelayUdpFront({ port: udpPort });
    const started = await front.start();
    if (started.ok) {
      relayUdpFront = front;
      try {
        const { getLocalRelay } = require('../cli/services/toolkit/subscription-aggregator/relay/local-relay');
        getLocalRelay().attachUdpEndpoint({ port: started.port, advertiseHost: front.advertiseHost() });
      } catch (_error) {
        // 中转没装配：UDP 前端留着也无害（没有关联可用）。
      }
      console.log(`\x1b[90m[aih]\x1b[0m relay UDP front on udp/${started.port}`);
    } else {
      console.warn(`\x1b[33m[aih]\x1b[0m relay UDP front unavailable (${started.error}); UDP stays on TCP fallback`);
    }
  }
  // 公开端口已能响应。先完成有界 Go 启动探测，再恢复会阻塞事件循环的
  // 本地扫描/桌面出口；否则健康 Go 会被这些初始化工作拖过探针门限。
  // Host 自行捕获启动失败，Node 保持服务，Go 路由仍按原合同失败关闭。
  const goCoreStartAt = Date.now();
  await goCoreHost.start();
  console.log(`\x1b[90m[aih:startup]\x1b[0m goCoreHost.start ${Date.now() - goCoreStartAt}ms (after listen)`);
  goUsageEventFeed.start();
  goCredentialBlockRecovery.start();

  const loadServerIdentity = typeof deps.loadOrCreateServerIdentity === 'function'
    ? deps.loadOrCreateServerIdentity
    : loadOrCreateServerIdentity;
  try {
    const serverIdentity = loadServerIdentity({ fs, aiHomeDir });
    if (serverIdentity) state.serverIdentity = serverIdentity;
  } catch (error) {
    console.warn(`\x1b[33m[aih]\x1b[0m server identity unavailable: ${error.message || error}`);
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
        fetchModelsForAccount: fetchModelsForAccountWithRefresh,
        accountStateService
      }
    });

    try {
      const quotaProbeScheduler = createAccountQuotaProbeScheduler({
        fs,
        aiHomeDir,
        ensureUsageSnapshotAsync,
        listAccounts: () => {
          const liveState = state && state.__webUiAccountsLive;
          if (liveState && liveState.records) {
            return Array.from(liveState.records.values());
          }
          const all = [];
          if (state && state.accounts) {
            Object.values(state.accounts).forEach(list => {
              if (Array.isArray(list)) all.push(...list);
            });
          }
          return all;
        }
      }, options);
      quotaProbeScheduler.start();
    } catch (_quotaSchedulerErr) {}
  });

  // 会话实时同步只允许用户在 WebUI/显式 API 中主动启用。
  // Server 启动不能偷偷修改 ~/.codex、~/.claude 等用户配置；未安装官方 Hook
  // 时继续使用已有的文件轮询兜底，并在 WebUI 中诚实展示状态。

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

  // 窗口激活：对滚动限额窗口类账号（当前典型是 Codex Plus）在「窗口关闭后」补一个
  // 极小探测，让窗口持续滚动（窗口只在账号被使用时才前进，所以关窗即续是唯一有效动作）。
  // 默认关（全局 + 逐账号双重 opt-in），探测走 /v1/* 数据面、绝不建项目会话。
  // 构造点在 listen 之后，baseUrl 取实际监听端口。
  // 全局 opt-in 的正规入口是保存配置（`aih server config set --window-activation`），
  // 由 buildServerArgsFromConfig 下发成本进程的 `--window-activation`；环境变量/CLI
  // 参数仍然直接生效（`AIH_SERVER_WINDOW_ACTIVATION=1`、`aih server serve --window-activation`）。
  windowActivationScheduler = createWindowActivationScheduler({
    fs,
    aiHomeDir,
    resolveBaseUrl: () => {
      const addr = listener.address();
      const port = addr && typeof addr === 'object' ? addr.port : options.port;
      return `http://127.0.0.1:${port}`;
    },
    clientKey: requiredClientKey,
    accountActivity,
    fetchImpl: fetchWithTimeout,
    // 探测模型从目标账号自己的模型目录解析：写死的模型被上游下线时，网关会在路由层
    // 把该账号排除（快速 503），探测一次都打不到账号上（2026-10-15 实测）。
    listAccountModels: (accountRef) => findModelsForAccount(state.modelAccountIndex, accountRef),
    listAccounts: () => {
      const liveState = state && state.__webUiAccountsLive;
      if (liveState && liveState.records) {
        return Array.from(liveState.records.values());
      }
      const all = [];
      if (state && state.accounts) {
        Object.values(state.accounts).forEach((list) => {
          if (Array.isArray(list)) all.push(...list);
        });
      }
      return all;
    },
    config: {
      enabled: options.windowActivation === true,
      defaultIntervalMs: options.windowActivationDefaultIntervalMs,
      minIntervalMs: options.windowActivationMinIntervalMs,
      tickIntervalMs: options.windowActivationTickIntervalMs,
      startDelayMs: options.windowActivationStartDelayMs,
      batchSize: options.windowActivationBatchSize,
      probeTimeoutMs: options.windowActivationProbeTimeoutMs
    },
    logInfo: (msg) => {
      if (options.verbose || options.debug) console.log(`\x1b[90m[aih:window-activation]\x1b[0m ${msg}`);
    },
    logWarn: (msg) => {
      console.warn(`\x1b[33m[aih:window-activation]\x1b[0m ${msg}`);
    }
  });

  modelUsageScanScheduler.start();
  grokUsageRefresh.start();
  codebuddyUsageRefresh.start();
  zcodeUsageRefresh.start();
  providerCliUpgradeScheduler.start();
  windowActivationScheduler.start();
  // 插件：已启用的实例在后台恢复，不阻塞启动；没有启用实例时不启动宿主，失败只记为 degraded。
  const pluginSystem = getPluginSystem(state, {
    aiHomeDir,
    pricingSourceStore,
    pricingRefreshIntervalMs: options.pricingRefreshIntervalMs,
    // 社区兜底只在定时刷新时抓取；首次启动不因网络不可用阻塞服务。
    pricingSourceCommunityRefresh: ({ store }) => refreshCommunitySources({
      store,
      fetchImpl,
      requireReview: true
    }),
    pricingApplied: () => modelUsageService.syncPricingIfStale({ force: true, recalculateCosts: true })
      .catch(() => {})
  });
  pluginSystem.runtime.start().catch(() => {});
  pluginSystem.pricing.start();
  // Go 数据面按 Node 推送的投影执行 gateway.request；Go 重启后下一轮推送即恢复确认。
  if (goCoreHost && typeof goCoreHost.pushPluginProjection === 'function') {
    attachGoProjection(pluginSystem, (payload) => goCoreHost.pushPluginProjection(payload), {
      // Go → Node 账号引用（同步 rekey / 身份合并后可能不同），让 Go 投递的观察事件与 Node 的一致。
      accountRefs: () => {
        const byNode = typeof goCoreHost.goRefsByNodeRef === 'function' ? goCoreHost.goRefsByNodeRef() || {} : {};
        const byGo = {};
        for (const [nodeRef, goRef] of Object.entries(byNode)) if (goRef && goRef !== nodeRef) byGo[goRef] = nodeRef;
        return byGo;
      }
    });
  }

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
    let pathname = url.pathname || '/';
    const requestId = createRequestId();
    const clientIp = requestClientIp(req);
    const requiredManagementKey = managementKeyRotation.getRequiredManagementKey();

    if (pathname === SESSION_WATCH_WEBSOCKET_PATH) {
      sessionWatchWebSockets.handleUpgrade(req, socket, head);
      return;
    }

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

    if (goCoreHost.tryHandleUpgrade(req, socket, head, { pathname, requestId })) return;

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

    await handleCodexResponsesWebSocket({ req, socket, head, state, options }, {
      chooseAccount: chooseServerAccountWithRuntimeSync,
      isLoopbackUrl,
      accountActivity,
      // WS relay 的账号状态变更同样走统一门禁。
      accountRuntimeGate,
      markProxyAccountFailure: markProxyAccountFailureAndPersist,
      markProxyAccountSuccess: markProxyAccountSuccessAndPersist,
      onRetry: event => {
        if (options.verbose || options.debug) console.log('[aih:ws] account failover', event);
      },
      onRetryUnavailable: event => {
        if (options.verbose || options.debug) console.warn('[aih:ws] account recovery stopped', event);
      },
      onError: error => {
        if (options.debug) console.error('[aih:ws] WebSocket upgrade failed:', error.message);
      }
    });
  });

  // 启动后台 Token 自动刷新守护进程
  const tokenRefreshDaemon = createTokenRefreshDaemon(state, options, {
    fetchWithTimeout,
    fs,
    aiHomeDir,
    hostHomeDir,
    reconcileKimiHostCredentials,
    accountArtifactHooks,
    accountStateService,
    accountRuntimeGate,
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

  // 排空后关闭剩余客户端连接。分流模式下 http server 从不 listen，Node 的
  // closeAllConnections() 对分流器交进来的 socket 无效（实测连接照旧、listener.close()
  // 被拖 3s），所以那一半必须由分流器自己销毁（见 relay-port-mux 的 destroyConnections）。
  function closeClientConnections() {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    if (relayMux.enabled() && typeof relayMux.destroyConnections === 'function') {
      relayMux.destroyConnections();
    }
  }

  function stopServer(signal = 'manual') {
    if (stopPromise) return stopPromise;
    lifecycleStopping = true;
    removeProcessSignalListeners();
    console.log(`\x1b[90m[aih]\x1b[0m received ${signal}, shutting down server...`);

    if (listener.listening) {
      listener.close();
      if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
    } else {
      resolveClosed();
    }
    if (relayUdpFront) {
      relayUdpFront.stop();
      relayUdpFront = null;
    }
    // 监听已关闭：新请求连接失败由客户端退避重试；在途推理请求（含转发给 Go 的流）
    // 只有一个短宽限（见 inference-drain.js：极速重启优先），之后关剩余长连接、停 Go。
    const drainTimeoutMs = Number(options.shutdownDrainTimeoutMs) > 0
      ? Number(options.shutdownDrainTimeoutMs)
      : DEFAULT_DRAIN_TIMEOUT_MS;
    if (inferenceDrain.inFlight() > 0) {
      console.log(`\x1b[90m[aih]\x1b[0m draining ${inferenceDrain.inFlight()} in-flight inference request(s) (up to ${Math.round(drainTimeoutMs / 1000)}s)...`);
    }
    const drained = inferenceDrain.waitForIdle(drainTimeoutMs).then((idle) => {
      if (!idle) console.warn(`\x1b[33m[aih]\x1b[0m drain timeout: closing ${inferenceDrain.inFlight()} unfinished inference request(s)`);
      closeClientConnections();
    });

    cancelInterval(logSweepTimer);
    // 停服后不能再往 aiHomeDir 落盘：否则会在调用方删掉的目录里重新建出 run/。
    clearInterval(accountActivityFlush);
    accountSessionActivityPoller.stop();
    nativeSessionOutcomePollers.forEach((poller) => poller.stop());
    nodeAccountOutcomes.stop();
    const webUiModelRefreshScheduler = state.webUiModelRefreshScheduler;
    if (webUiModelRefreshScheduler && webUiModelRefreshScheduler.timer) {
      const cancelTimeout = typeof deps.clearTimeout === 'function' ? deps.clearTimeout : clearTimeout;
      cancelTimeout(webUiModelRefreshScheduler.timer);
      webUiModelRefreshScheduler.timer = null;
    }

    // 排空后、停 Go 之前最后拉一次用量事件，排空期间完成的请求也能入账。
    stopPromise = drained
      .then(() => goUsageEventFeed.stop())
      .then(() => goCredentialBlockRecovery.stop())
      .catch(() => {})
      .then(() => runShutdownCleanup());
    return stopPromise;
  }

  // 停机环节计时：这些环节并发执行、各自带内置超时，总时长 = 最慢的那个。
  // 没有这层计时，「关闭为什么慢」只能靠猜 —— 线上曾出现 149 次关闭打满上层
  // deadline、其中 44 次根本没有在途推理请求，却无法指出是哪一环在拖。
  // 只在超过阈值时打印，正常关闭保持安静。
  function timedShutdownStep(name, task) {
    if (!task) return null;
    const startedAt = Date.now();
    return Promise.resolve(task)
      .catch((error) => {
        console.warn(`\x1b[33m[aih:shutdown]\x1b[0m ${name} failed: ${String((error && error.message) || error)}`);
      })
      .then(() => {
        const elapsedMs = Date.now() - startedAt;
        if (elapsedMs >= SHUTDOWN_STEP_LOG_THRESHOLD_MS) {
          console.log(`\x1b[90m[aih:shutdown]\x1b[0m ${name}: ${elapsedMs}ms`);
        }
        return elapsedMs;
      });
  }

  function runShutdownCleanup() {
    const cleanupTasks = [
      ['sessionWatchWebSockets.close', invokeLifecycle(sessionWatchWebSockets, 'close')],
      ['tokenRefreshDaemon.stop', invokeLifecycle(tokenRefreshDaemon, 'stop')],
      ['runtimeRecovery.stop', invokeLifecycle(runtimeRecovery, 'stop')],
      ['sourceAutoRestart.stop', invokeLifecycle(sourceAutoRestart, 'stop')],
      ['modelUsageScanScheduler.stop', invokeLifecycle(modelUsageScanScheduler, 'stop')],
      ['grokUsageRefresh.stop', invokeLifecycle(grokUsageRefresh, 'stop')],
      ['codebuddyUsageRefresh.stop', invokeLifecycle(codebuddyUsageRefresh, 'stop')],
      ['zcodeUsageRefresh.stop', invokeLifecycle(zcodeUsageRefresh, 'stop')],
      ['providerCliUpgradeScheduler.stop', invokeLifecycle(providerCliUpgradeScheduler, 'stop')],
      ['windowActivationScheduler.stop', invokeLifecycle(windowActivationScheduler, 'stop')],
      ['pluginSystem.pricing.stop', invokeLifecycle(pluginSystem.pricing, 'stop')],
      ['pluginSystem.runtime.stop', invokeLifecycle(pluginSystem.runtime, 'stop')],
      ['modelUsageService.close', invokeLifecycle(modelUsageService, 'close')],
      ['codexCliHookSelfHeal.stop', invokeLifecycle(codexCliHookSelfHeal, 'stop')],
      ['codexDesktopHookSelfHeal.stop', invokeLifecycle(codexDesktopHookSelfHeal, 'stop')],
      ['codexVscodeHookSelfHeal.stop', invokeLifecycle(codexVscodeHookSelfHeal, 'stop')],
      ['codexSessionNotificationBridge.stop', invokeLifecycle(codexSessionNotificationBridge, 'stop')],
      ['chatRuntimeService.close', invokeLifecycle(chatRuntimeService, 'close')],
      ['sessionLifecycleService.close', invokeLifecycle(sessionLifecycleService, 'close')],
      ['relaySessionRegistry.closeAll', invokeLifecycle(relaySessionRegistry, 'closeAll')],
      ['webrtcSessionRegistry.closeAll', invokeLifecycle(webrtcSessionRegistry, 'closeAll')],
      ['fabricBrokerSessionRegistry.closeAll', invokeLifecycle(fabricBrokerSessionRegistry, 'closeAll')],
      ['outboundRelayManager.stop', invokeLifecycle(outboundRelayManager, 'stop')],
      ['goCoreHost.stop', invokeLifecycle(goCoreHost, 'stop')],
      ['egressPoolLanes.stop', invokeLifecycle(egressPoolLanes, 'stop')],
      ['egressPool.stop', invokeLifecycle(egressPool, 'stop')],
      // 注销单例：否则请求热路径会读到一个已经停掉的池，拿到失效的出站地址。
      ['egressPoolService.unregister', Promise.resolve().then(() => setEgressPoolService(null))]
    ].map(([name, task]) => timedShutdownStep(name, task)).filter(Boolean);
    if (typeof unsubscribeCodexAuthInvalidDeletion === 'function') {
      cleanupTasks.push(timedShutdownStep(
        'codexAuthInvalidDeletion.unsubscribe',
        Promise.resolve().then(() => unsubscribeCodexAuthInvalidDeletion())
      ));
    }
    for (const [index, unregister] of unregisterAccountRuntimeListeners.entries()) {
      if (typeof unregister === 'function') {
        cleanupTasks.push(timedShutdownStep(
          `accountRuntimeListeners[${index}].unregister`,
          Promise.resolve().then(() => unregister())
        ));
      }
    }

    return Promise.allSettled([...cleanupTasks, closed])
      .then(() => undefined)
      .finally(() => {
        if (serverInstanceLock && typeof serverInstanceLock.release === 'function') {
          serverInstanceLock.release();
        }
      });
  }

  function requestProcessShutdown(signal) {
    if (processShutdownRequested) return;
    processShutdownRequested = true;
    // 强退兜底必须晚于推理排空上限，否则排空形同虚设。
    const drainTimeoutMs = Number(options.shutdownDrainTimeoutMs) > 0
      ? Number(options.shutdownDrainTimeoutMs)
      : DEFAULT_DRAIN_TIMEOUT_MS;
    forceExitTimer = setTimeout(() => {
      processObj.exit(1);
    }, drainTimeoutMs + 15000);
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
    const upgradeState = providerCliUpgradeScheduler.getState();
    console.log(`\x1b[90m[aih]\x1b[0m Provider CLI upgrade ${upgradeState.enabled ? (upgradeState.applyEnabled ? 'started' : 'started (check-only)') : 'disabled'} (interval: ${upgradeState.intervalMs}ms, providers: ${upgradeState.providers.length})`);
    const waState = windowActivationScheduler.getState();
    console.log(`\x1b[90m[aih]\x1b[0m Window activation ${waState.enabled ? 'started' : 'disabled'} (default interval: ${waState.defaultIntervalMs}ms, tick: ${waState.tickIntervalMs}ms)`);
  }
  const listeningAddress = listener.address();
  const address = Object.freeze({
    host: options.host,
    port: listeningAddress && typeof listeningAddress === 'object'
      ? listeningAddress.port
      : options.port
  });
  // `listener` 是真正持有端口的对象：中转「跟随 AIH 端口」时它是分流器的 TCP server，
  // http server 只通过 emit('connection') 收连接（那种情况下 server.listening 恒为 false）。
  // 需要判断「是否在监听 / 何时停止」时用 listener，不要用 server。
  return Object.freeze({ server, listener, address, stop: stopServer, closed });
}

module.exports = {
  startLocalServer
};
