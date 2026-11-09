'use strict';

const { resolveNativeFallbackAccountRefs } = require('./webui-chat-routes-native-session');

const { DefaultProviderRuntimeResolver } = require('../runtime/default-provider-runtime');
const crypto = require('node:crypto');
const { ChatRuntimeEventHub } = require('./chat-runtime-event-hub');
const { createChatRuntimeService } = require('./chat-runtime-service');
const { normalizeEvent } = require('./chat-runtime/contracts');
const {
  createCapabilityCommandCatalog
} = require('./chat-runtime/capability-command-catalog');
const { createCodexDriverEntry } = require('./chat-runtime/codex-session-driver');
const { createNativeSessionDriverEntry } = require('./chat-runtime/native-session-driver');
const { NativeApprovalSurface } = require('./chat-runtime/native-approval-surface');
const { DEFAULT_SERVER_PORT } = require('./server-defaults');
const { isGatewayRuntimeScope } = require('../account/runtime-target');
const { OFFICIAL_NATIVE_SESSION_PROVIDERS } = require('./native-session-chat-utils');
const { isChatSession, chatWorkingDirectory } = require('./chat-runtime/chat-harness-policy');
const { ChatRuntimeError } = require('./chat-runtime/contracts');
const { ChatGatewayModelCatalog, createChatGatewayOptions, usesChatGateway } = require('./chat-runtime/chat-harness-gateway');
const { createGoChatDriverEntry } = require('./chat-runtime/go-chat-driver');
const { createCapabilityRoutedChatDriverEntry } = require('./chat-runtime/capability-routed-driver');
const { codexCapabilities } = require('./chat-runtime/codex-session-driver-support');
const { legacyResponseItems } = require('./chat-runtime/chat-session-coordinator');
const { readChatSession } = require('./webui-chat-store');
const {
  createProviderDriverRegistration,
  createProviderDriverRegistry
} = require('./chat-runtime/provider-driver-registry');
const {
  withRuntimePrewarmLifecycle
} = require('./chat-runtime/runtime-prewarm-lifecycle');
const {
  createUnsupportedArtifactReader
} = require('./chat-runtime/unsupported-artifact-reader');
const {
  createMetadataAwareRuntimeResolver,
  createProviderRuntimeMetadataPort
} = require('./provider-runtime-metadata');

function createChatRuntimeComposition(options = {}) {
  // Go 内部聊天入口：能力路由判定为 relay 的轮次由它执行。缺端口时启动即失败，
  // 而不是等第一个 Go 轮次才报错；canonical Provider 的轮次仍走旧的 Node 驱动。
  const streamChatTurn = requireChatInferencePort(options);
  const eventHub = new ChatRuntimeEventHub();
  const runtimeResolver = createRuntimeResolver(options);
  const interactionReleaseFailureSink = resolveInteractionReleaseFailureSink(options);
  const extensionObserverErrorSink = resolveExtensionObserverErrorSink(options);
  let service;
  const providerRegistry = createProviderDriverRegistry([
    createCodexProviderRegistration(
      options,
      eventHub,
      () => service,
      interactionReleaseFailureSink
    ),
    ...nativeSessionProviderRegistrations(options, eventHub, () => service, interactionReleaseFailureSink),
    ...(options.providerDriverRegistrations || [])
  ]);
  const driverRegistry = {
    resolve(provider, context) {
      if (!isChatSession(context.session)) return providerRegistry.resolve(provider, context);
      const { session, runtime } = context;
      // 纯聊天（无项目目录）按**本轮能力**路由：Go 只承接聊天透传通道真能服务的
      // 轮次（relay Provider），其余交还旧的 Node codex 驱动。work 会话继续走
      // 原生/Codex 驱动：它们需要工具、PTY 与工作区，Go 切片没有。
      const ports = createSessionPorts(() => service, eventHub, session, runtime);
      const composerCatalog = createComposerCatalog(session, options);
      return createCapabilityRoutedChatDriverEntry({
        session: codexDriverSession(session),
        composerCatalog,
        // canonical Node 驱动的能力集：路由判定为 Go 的轮次由 entry.capabilitiesFor
        // 换成 Go 子集（见 capability-routed-driver），这里只声明 Node 侧的上限。
        capabilities: codexCapabilities(runtime),
        getSessionPolicy: ports.getSessionPolicy,
        getModelAccountIndex: options.getModelAccountIndex,
        diagnostics: createChatRuntimeDiagnostics(options),
        createGoEntry: () => createGoChatDriverEntry({
          session: codexDriverSession(session),
          getSessionPolicy: ports.getSessionPolicy,
          eventSink: ports.eventSink,
          readChatHistory: ports.readChatHistory,
          createItemId: ports.createItemId,
          streamTurn: streamChatTurn,
          composerCatalog
        }),
        // 旧的 chat 推理路径：与 HEAD^ 的 chat 分支逐项一致，只在真的交还 Node 时构造。
        createNodeEntry: () => withRuntimePrewarmLifecycle(createCodexDriverEntry({
          ...options,
          session: {
            ...codexDriverSession(session),
            provider: 'codex',
            projectPath: chatWorkingDirectory(session, options)
          },
          runtime,
          isModelEnabled: modelPolicyForSession(options, session),
          runtimeNamespace: 'chat',
          spawnSyncImpl: options.spawnSync,
          interactionReleaseFailureSink,
          nativeThreadItemFailureSink: createChatRuntimeDiagnostics(options),
          // 启动前对账/准备失败的诊断出口：只写 server.log，不影响轮次结果。
          diagnostics: createChatRuntimeDiagnostics(options),
          ...(usesChatGateway(session, options) ? createChatGatewayOptions(session, options) : {}),
          clientFactory: options.codexClientFactory,
          initialHistory: service.store.readHistorySeed(session.sessionId)?.responseItems
            || (session.policy.legacySessionId
              ? legacyResponseItems(readChatSession(session.policy.legacySessionId, options.hostHomeDir)) : []),
          ...ports
        }))
      });
    }
  };
  service = createChatRuntimeService({
    artifactReader: options.artifactReader || createUnsupportedArtifactReader(),
    catalog: options.catalog || createCapabilityCommandCatalog(),
    driverRegistry,
    extensions: options.extensions,
    extensionObserverErrorSink,
    eventHub,
    runtimeResolver,
    attachmentOptions: {
      fs: options.fs,
      aiHomeDir: options.aiHomeDir,
      hostHomeDir: options.hostHomeDir
    },
    storeOptions: {
      fs: options.fs,
      aiHomeDir: options.aiHomeDir
    },
    traceSink: createTraceSink(options.appendServerLog),
    hostHomeDir: options.hostHomeDir,
    workspaceCheckpoints: (projectPath) => require('./workspace-checkpoints').openWorkspaceCheckpoints({
      fs: options.fs, aiHomeDir: options.aiHomeDir, projectPath
    })
  });
  // Restore a warm model picker after a server restart without delaying server
  // readiness. The service owns the bounded session selection and dedup cache.
  Promise.resolve().then(() => service.prewarmRecentComposerCatalogs()).catch(() => {});
  return service;
}

/**
 * 聊天推理端口：Node 的轮次执行用它把一轮 turn.submit 交给 Go。
 *
 * 端口在装配期就要求存在——缺它时 relay Provider 的轮次没有可用的执行方，
 * 必须在启动时失败，而不是等第一轮对话才报错。
 */
function requireChatInferencePort(options) {
  const port = options.chatInference;
  if (!port || typeof port.streamTurn !== 'function') {
    throw new Error('chat_inference_port_required');
  }
  return port.streamTurn;
}

/**
 * 聊天 composer 的模型目录。
 *
 * 目录仍由 Node 的网关读取（全局池 + 账号开关过滤），与旧 harness 完全同源；
 * Go 只按本轮选中的模型路由，不参与目录生成。
 */
function createComposerCatalog(session, options) {
  const gateway = options.chatGateway;
  if (!gateway || typeof gateway.readModels !== 'function') {
    throw new ChatRuntimeError('chat_harness_gateway_unavailable', 503);
  }
  const catalog = new ChatGatewayModelCatalog(session, gateway);
  return async () => {
    const models = await catalog.list();
    const defaultEntry = models.find((entry) => entry.isDefault) || models[0];
    return {
      models: models.map((entry) => ({
        id: entry.model,
        label: entry.displayName,
        supportedEfforts: entry.supportedReasoningEfforts,
        defaultEffort: entry.defaultReasoningEffort
      })),
      defaultModel: defaultEntry ? defaultEntry.model : ''
    };
  };
}

/**
 * 本轮要带给 Go 的会话历史：只取已经完成的消息，按时间正序。
 *
 * 进行中/失败的助手消息不进入上下文——它们要么还没生成完，要么本来就不该被
 * 模型当成「自己说过的话」。
 */
function readChatHistory(service, sessionId) {
  const page = service.store.readTimeline(sessionId, { limit: 100 });
  return (page.items || [])
    .filter((item) => item && item.kind === 'message'
      && item.status === 'completed'
      && item.detail && ['user', 'assistant'].includes(item.detail.role)
      && typeof item.content === 'string' && item.content.trim())
    .map((item) => ({ role: item.detail.role, content: item.content }));
}

/** 会话运行期诊断出口：统一写 server.log（kind=chat_runtime_diagnostic），无出口时静默。 */
function createChatRuntimeDiagnostics(options = {}) {
  return (entry) => {
    if (typeof options.appendServerLog !== 'function') return;
    try {
      options.appendServerLog({
        at: new Date().toISOString(),
        kind: 'chat_runtime_diagnostic',
        ...entry
      });
    } catch (_error) { /* 日志出口失败不影响会话 */ }
  };
}

function createCodexProviderRegistration(options, eventHub, getService, releaseFailureSink) {
  return createProviderDriverRegistration({
    provider: 'codex',
    createEntry: ({ session, runtime }) => withRuntimePrewarmLifecycle(
      createCodexDriverEntry({
        session: codexDriverSession(session),
        runtime,
        isModelEnabled: modelPolicyForSession(options, session),
        fs: options.fs,
        aiHomeDir: options.aiHomeDir,
        credentialAiHomeDir: options.credentialAiHomeDir,
        env: options.env,
        getProfileDir: options.getProfileDir,
        ensureSessionStoreLinks: options.ensureSessionStoreLinks,
        accountIdentityValidator: options.accountIdentityValidator,
        spawnSyncImpl: options.spawnSync,
        clientFactory: options.codexClientFactory,
        interactionReleaseFailureSink: releaseFailureSink,
        // 线程条目写失败（如 identity 冲突）按 coverage gap 降级，但要可观察。
        nativeThreadItemFailureSink: createChatRuntimeDiagnostics(options),
        ...createSessionPorts(getService, eventHub, session, runtime)
      })
    )
  });
}
/**
 * 原生会话驱动的注册（work 模式）：名单来自**引擎能力集**
 * （native-session-chat-utils 的 OFFICIAL_NATIVE_SESSION_PROVIDERS），不在这里写 provider 清单
 * —— 引擎加一支，这里自动跟上。codex 已由 app-server 驱动覆盖，跳过避免重复注册。
 */
function nativeSessionProviderRegistrations(options, eventHub, getService, releaseFailureSink) {
  return [...OFFICIAL_NATIVE_SESSION_PROVIDERS]
    .filter((provider) => provider !== 'codex')
    .map((provider) => createProviderDriverRegistration({
      provider,
      createEntry: ({ session, runtime }) => {
        const ports = createSessionPorts(getService, eventHub, session, runtime);
        return createNativeSessionDriverEntry({
          session,
          runtime,
          fs: options.fs,
          env: options.env,
          aiHomeDir: options.aiHomeDir,
          hostHomeDir: options.hostHomeDir,
          getProfileDir: options.getProfileDir,
          ensureSessionStoreLinks: options.ensureSessionStoreLinks,
          readModels: options.chatGateway && options.chatGateway.readModels,
          // 默认模型解析：与 legacy 同一处（provider-default-models），驱动不猜模型。
          resolveDefaultModel: options.chatGateway && options.chatGateway.resolveDefaultModel,
          // 账号运行态端口（延迟求值）：native session 的失败/阻塞要能写回账号运行态。
          getAccountRuntimePorts: options.chatGateway && options.chatGateway.getAccountRuntimePorts,
          interactionReleaseFailureSink: releaseFailureSink,
          // 审批传输所需上下文（策略行按需取用，驱动不判 provider）：
          //   approvalRequestUrl —— MCP 权限工具的回传端点（与 legacy 同一 ingress，内部按归属分流）
          approvalRequestUrl: chatRuntimeApprovalRequestUrl(options),
          resolveAccountType: options.resolveAccountType,
          // 换号重试候选：与 legacy 同一处（webui-chat-routes-native-session.resolveNativeFallbackAccountRefs）。
          resolveFallbackAccountRefs: (provider, accountRef) => resolveNativeFallbackAccountRefs(
            options.loadServerRuntimeAccounts, provider, accountRef),
          onTurnCompleted: typeof options.onNativeTurnCompleted === 'function'
            ? options.onNativeTurnCompleted : undefined,
          // 启动准备管线的诊断出口：声明的步骤没有实现/端口不可用时必须可观察（绝不静默跳过）。
          diagnostics: createChatRuntimeDiagnostics(options),
          createApprovalSurface: () => new NativeApprovalSurface({
            sessionId: session.sessionId,
            eventSink: ports.eventSink,
            idFactory: ports.interactionIdFactory,
            releaseFailureSink
          }),
          ...ports
        });
      }
    }));
}

/** 审批回传端点：canonical 与 legacy 共用同一个 loopback ingress（见 webui-chat-routes）。 */
function chatRuntimeApprovalRequestUrl(options) {
  const port = options.chatGateway && options.chatGateway.port || DEFAULT_SERVER_PORT;
  return `http://127.0.0.1:${port}/v0/webui/internal/approval-request`;
}



function createRuntimeResolver(options) {
  const descriptorResolver = options.runtimeResolver || new DefaultProviderRuntimeResolver({
    fs: options.fs,
    env: options.env,
    spawn: options.spawn,
    spawnSync: options.spawnSync,
    nativeCliOptions: { projectFallback: false },
    resolveNativeCliPath: options.resolveNativeCliPath
  });
  const metadataPort = options.runtimeMetadataPort || createProviderRuntimeMetadataPort({
    accountArtifactHooks: options.accountArtifactHooks,
    authRevisionPort: options.accountAuthRevisionPort,
    definitions: options.providerRuntimeDefinitions
  });
  const resolver = createMetadataAwareRuntimeResolver(descriptorResolver, metadataPort);
  return {
    descriptorResolver,
    async resolve(provider, context = {}) {
      if (!context.chat) return resolver.resolve(provider, context);
      const metadata = await metadataPort.resolve(provider, context);
      const gateway = options.chatGateway;
      // 网关作用域的 authRevision **不含 provider**：pane 按 runtimeScope 键控
      // （`chat-gateway` 一个），同一 pane 下不同 provider 的会话必须得到同一份执行身份，
      // 否则 runtime fingerprint 各不相同、常驻 pane 会被反复重建（真机实测：
      // 三个 provider 的会话 runtimeGeneration 递增 1→2→3）。
      // 身份由「网关端口 + client key + 该作用域」唯一确定，与推理 provider 无关 ——
      // provider 只影响 models.dev 元数据解析，不改变执行凭据。
      const authRevision = gateway
        ? crypto.createHash('sha256').update(JSON.stringify([
          isGatewayRuntimeScope(context.runtimeScope) ? '' : provider,
          context.runtimeScope, metadata.authRevision, gateway.port, gateway.clientKey
        ])).digest('hex') : metadata.authRevision;
      return descriptorResolver.resolve('codex', {
        ...context, ...metadata, authRevision, runtimeScope: `chat-${context.runtimeScope}`
      });
    }
  };
}

function modelPolicyForSession(options, session) {
  const gateway = options.chatGateway;
  return typeof gateway?.isModelEnabled === 'function'
    ? (model) => gateway.isModelEnabled(session.provider, session.executionAccountRef, model)
    : undefined;
}

function codexDriverSession(session) {
  return {
    ...session,
    runtimeBinding: session.runtimeBinding || {},
    policy: session.policy || {}
  };
}

function createSessionPorts(getService, eventHub, session, runtime) {
  return {
    getSessionPolicy: () => {
      const current = getService().store.getSession(session.sessionId);
      return current && current.policy;
    },
    // Go 轮次驱动：Go 不持有会话，历史与条目 id 都由 Node 提供。
    readChatHistory: () => readChatHistory(getService(), session.sessionId),
    createItemId: () => getService().store.context.idFactory('item'),
    historySink: (history) => getService().store.importTimeline(
      session.sessionId,
      history.events
    ),
    // 原生历史导入的前置判断：时间线里已有消息就不再导入（新轮次由驱动实时写入）。
    hasTimelineMessages: () => getService().store.readTimeline(session.sessionId, { limit: 100 })
      .items.some((item) => item && item.kind === 'message'),
    eventSink: (event) => persistProviderEvent(getService(), session, runtime, event),
    nativeResponseItemSink: (evidence) => getService().store.recordNativeResponseItem(session.sessionId, evidence),
    interactionIdFactory: () => getService().store.context.idFactory('interaction'),
    nativeThreadItemSink: (evidence) => getService().store.store.nativeThreadItems.record(session.sessionId, evidence),
    readNativeThreadItems: (turnId) => {
      const store = getService().store.store;
      return store.nativeThreadItems.readTurn(session.sessionId,
        store.getSession(session.sessionId).runtimeBinding.nativeSessionId, turnId);
    },
    nativeHistoryCoverageSink: (evidence) => getService().store.markNativeHistoryCoverage(session.sessionId, evidence),
    readNativeResponseItem: (itemId) => getService().store.readNativeResponseItem(session.sessionId, itemId),
    readNativeTurn: (turnId) => {
      const store = getService().store.store;
      return store.nativeResponseItems.readTurn(session.sessionId,
        store.getSession(session.sessionId).runtimeBinding.nativeSessionId, turnId);
    },
    readNativeCoverage: (turnId) => {
      const store = getService().store.store;
      return store.nativeResponseItems.coverage(session.sessionId,
        store.getSession(session.sessionId).runtimeBinding.nativeSessionId, turnId);
    },
    readInheritedBranchPlan: () => {
      const store = getService().store.store;
      const lineage = store.getSession(session.sessionId)?.policy.lineage;
      return lineage ? store.branchOperations.read(lineage.parentSessionId, lineage.commandId)?.plan : null;
    },
    transientEventSink: (event) => publishTransientEvent(
      getService(), eventHub, session, runtime, event
    ),
    extensions: getService().extensions,
    onNativeSessionBound: (nativeSessionId, details) => getService().store.updateRuntimeBinding(
      session.sessionId,
      { nativeSessionId }, details?.replacement
    ),
    onNativeTurnStarted: (anchor) => getService().store.updateActiveTurnAnchor(
      session.sessionId,
      anchor
    )
  };
}

function persistProviderEvent(service, session, runtime, event = {}) {
  if (event.type === 'interaction.requested') {
    return createPendingInteraction(service.store, session.sessionId, event);
  }
  if (event.type === 'interaction.resolved') {
    return resolveExternalInteraction(service.store, event);
  }
  return service.store.appendEvent(session.sessionId, {
    ...event,
    source: runtimeSource(session, runtime)
  });
}

function createPendingInteraction(store, sessionId, event) {
  const interaction = event.payload && event.payload.interaction || {};
  return store.createInteraction({
    interactionId: interaction.interactionId,
    sessionId,
    itemId: interaction.itemId,
    kind: interaction.kind,
    revision: interaction.revision,
    payload: interaction.payload
  });
}

function resolveExternalInteraction(store, event) {
  const interactionId = String(event.payload && event.payload.interactionId || '').trim();
  return interactionId ? store.acknowledgeExternalInteraction(interactionId) : null;
}

function publishTransientEvent(service, eventHub, session, runtime, event) {
  const context = service.store.context;
  const normalized = normalizeEvent({
    ...event,
    eventId: context.idFactory('event'),
    sessionId: session.sessionId,
    seq: 0,
    at: context.clock(),
    source: runtimeSource(session, runtime)
  });
  if (service && typeof service.observeTransientEvent === 'function') {
    service.observeTransientEvent(normalized);
  }
  eventHub.publish(normalized);
  return normalized;
}

function runtimeSource(session, runtime) {
  const runtimeId = session.runtimeBinding && session.runtimeBinding.runtimeId
    || `${runtime.provider}:${runtime.runtimeScope}`;
  return { provider: session.provider, runtimeId };
}

function createTraceSink(appendServerLog) {
  if (typeof appendServerLog !== 'function') return () => {};
  return (snapshot) => appendServerLog({
    at: new Date().toISOString(),
    kind: 'chat_runtime_trace',
    ...snapshot
  });
}

function resolveInteractionReleaseFailureSink(options) {
  if (typeof options.interactionReleaseFailureSink === 'function') {
    return options.interactionReleaseFailureSink;
  }
  const appendServerLog = options.appendServerLog;
  if (typeof appendServerLog !== 'function') return () => {};
  return (diagnostic) => appendServerLog({
    ...diagnostic,
    at: new Date().toISOString(),
    kind: 'chat_runtime_interaction_release_failed'
  });
}

function resolveExtensionObserverErrorSink(options) {
  if (typeof options.extensionObserverErrorSink === 'function') {
    return options.extensionObserverErrorSink;
  }
  const appendServerLog = options.appendServerLog;
  if (typeof appendServerLog !== 'function') return () => {};
  return (error, _event, context = {}) => appendServerLog({
    at: new Date().toISOString(),
    kind: 'chat_runtime_extension_observer_failed',
    code: String(error && error.code || 'chat_runtime_extension_observer_failed'),
    message: String(error && error.message || 'extension observer failed').slice(0, 200),
    sessionId: String(context.sessionId || '')
  });
}

module.exports = { createChatRuntimeComposition };
