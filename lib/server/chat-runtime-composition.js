'use strict';

const { DefaultProviderRuntimeResolver } = require('../runtime/default-provider-runtime');
const { ChatRuntimeEventHub } = require('./chat-runtime-event-hub');
const { createChatRuntimeService } = require('./chat-runtime-service');
const { normalizeEvent } = require('./chat-runtime/contracts');
const {
  createCapabilityCommandCatalog
} = require('./chat-runtime/capability-command-catalog');
const { createCodexDriverEntry } = require('./chat-runtime/codex-session-driver');
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
  let service;
  const driverRegistry = createProviderDriverRegistry([
    createCodexProviderRegistration(
      options,
      eventHub,
      () => service,
      interactionReleaseFailureSink
    ),
    ...(options.providerDriverRegistrations || [])
  ]);
  service = createChatRuntimeService({
    artifactReader: options.artifactReader || createUnsupportedArtifactReader(),
    catalog: options.catalog || createCapabilityCommandCatalog(),
    driverRegistry,
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
    traceSink: createTraceSink(options.appendServerLog)
  });
  return service;
}

function createCodexProviderRegistration(options, eventHub, getService, releaseFailureSink) {
  return createProviderDriverRegistration({
    provider: 'codex',
    createEntry: ({ session, runtime }) => withRuntimePrewarmLifecycle(
      createCodexDriverEntry({
        session: codexDriverSession(session),
        runtime,
        fs: options.fs,
        aiHomeDir: options.aiHomeDir,
        credentialAiHomeDir: options.credentialAiHomeDir,
        env: options.env,
        getProfileDir: options.getProfileDir,
        accountIdentityValidator: options.accountIdentityValidator,
        spawnSyncImpl: options.spawnSync,
        clientFactory: options.codexClientFactory,
        interactionReleaseFailureSink: releaseFailureSink,
        ...createSessionPorts(getService, eventHub, session, runtime)
      })
    )
  });
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
  return createMetadataAwareRuntimeResolver(descriptorResolver, metadataPort);
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
    transientEventSink: (event) => publishTransientEvent(
      getService(), eventHub, session, runtime, event
    ),
    onNativeSessionBound: (nativeSessionId) => getService().store.updateRuntimeBinding(
      session.sessionId,
      { nativeSessionId }
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

module.exports = { createChatRuntimeComposition };
