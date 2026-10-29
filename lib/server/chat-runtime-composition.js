'use strict';

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
const { createChatGatewayOptions, usesChatGateway } = require('./chat-runtime/chat-harness-gateway');
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
      return withRuntimePrewarmLifecycle(createCodexDriverEntry({
        ...options,
        session: { ...codexDriverSession(session), provider: 'codex', projectPath: chatWorkingDirectory(session, options) },
        runtime,
        isModelEnabled: modelPolicyForSession(options, session),
        runtimeNamespace: 'chat',
        spawnSyncImpl: options.spawnSync,
        interactionReleaseFailureSink,
        nativeThreadItemFailureSink: createChatRuntimeDiagnostics(options),
        ...(usesChatGateway(session, options) ? createChatGatewayOptions(session, options) : {}),
        clientFactory: options.codexClientFactory,
        initialHistory: service.store.readHistorySeed(session.sessionId)?.responseItems
          || (session.policy.legacySessionId
            ? legacyResponseItems(readChatSession(session.policy.legacySessionId, options.hostHomeDir)) : []),
        ...createSessionPorts(() => service, eventHub, session, runtime)
      }));
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
    hostHomeDir: options.hostHomeDir
  });
  // Restore a warm model picker after a server restart without delaying server
  // readiness. The service owns the bounded session selection and dedup cache.
  Promise.resolve().then(() => service.prewarmRecentComposerCatalogs()).catch(() => {});
  return service;
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
      if (context.workspaceMode !== 'chat') return resolver.resolve(provider, context);
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
    historySink: (history) => getService().store.importTimeline(
      session.sessionId,
      history.events
    ),
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
