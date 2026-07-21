'use strict';

const { DefaultProviderRuntimeResolver } = require('../runtime/default-provider-runtime');
const {
  AutomaticQueueCoordinator
} = require('./chat-runtime/automatic-queue-coordinator');
const {
  ChatRuntimeActorRegistry,
  runtimeBindingPatch
} = require('./chat-runtime-actor-registry');
const { ChatRuntimeEventHub } = require('./chat-runtime-event-hub');
const { ChatRuntimePublishingStore } = require('./chat-runtime-publishing-store');
const { ChatRuntimeTrace } = require('./chat-runtime-trace');
const { ChatRuntimeTraceLifecycle } = require('./chat-runtime-trace-lifecycle');
const {
  ChatRuntimeRecoveryCoordinator
} = require('./chat-runtime-recovery-coordinator');
const {
  boundedLimit,
  createFreshSessionDraft,
  createSessionDraft,
  normalizeCursor,
  requireSession,
  retainedFirstSeq
} = require('./chat-runtime-service-support');
const {
  SessionResolutionCoordinator
} = require('./chat-runtime/session-resolution-coordinator');
const {
  ChatRuntimeAttachmentService
} = require('./chat-runtime/attachment-service');
const { openChatRuntimeStore } = require('./chat-runtime/store');

const DEFAULT_EVENT_RETENTION = 500;

class ChatRuntimeService {
  constructor(options) {
    this.eventHub = options.eventHub;
    this.ownsStore = options.ownsStore;
    this.catalog = options.catalog;
    this.artifactReader = options.artifactReader;
    this.eventRetentionLimit = options.eventRetentionLimit;
    this.traceLifecycle = options.traceLifecycle || new ChatRuntimeTraceLifecycle({
      traceFactory: options.traceFactory,
      traceSink: options.traceSink
    });
    this.store = new ChatRuntimePublishingStore({
      store: options.store,
      eventHub: this.eventHub,
      onCommandPersisted: (commandId, trace) => (
        this.traceLifecycle.markCommandPersisted(commandId, trace)
      ),
      onEventPublished: (event) => this.observePublishedEvent(event)
    });
    this.attachmentService = options.attachmentService || new ChatRuntimeAttachmentService({
      store: this.store,
      ...(options.attachmentOptions || {})
    });
    this.actors = new ChatRuntimeActorRegistry({
      store: this.store,
      runtimeResolver: options.runtimeResolver,
      driverRegistry: options.driverRegistry,
      idFactory: options.idFactory
    });
    this.sessionResolver = new SessionResolutionCoordinator({
      actors: this.actors,
      createDraft: (input) => createSessionDraft(input, this.store),
      publisher: this.store,
      store: options.store
    });
    this.recovery = new ChatRuntimeRecoveryCoordinator({
      actors: this.actors,
      store: this.store
    });
    this.queueAutomation = new AutomaticQueueCoordinator({
      store: this.store,
      dispatchCommand: (sessionId, command) => this.dispatchCommand(sessionId, command),
      waitForIdle: (sessionId) => this.waitForActorIdle(sessionId),
      idFactory: options.idFactory || this.store.context.idFactory,
      onError: options.queueAutomationErrorSink
    });
    this.recovery.start();
  }

  async createSession(input = {}) {
    const draft = createFreshSessionDraft(input, this.store);
    let prepared;
    try {
      prepared = await this.actors.prepare(draft);
      draft.runtimeBinding = runtimeBindingPatch(draft, prepared.runtime);
      draft.capabilitySnapshot = prepared.entry.capabilities || {};
      const session = this.store.createSession(draft);
      this.actors.register(session, prepared);
      return session;
    } finally {
      this.actors.disposePrepared(prepared);
    }
  }

  resolveSession(input = {}) { return this.sessionResolver.resolve(input); }

  listSessions(query = {}) { return this.store.listSessions(query) || []; }
  getSnapshot(sessionId) { return this.store.getSnapshot(sessionId); }
  readTimeline(sessionId, page = {}) { return this.store.readTimeline(sessionId, page); }
  uploadAttachments(sessionId, input = {}) {
    return this.attachmentService.upload(sessionId, input);
  }

  readEvents(sessionId, options = {}) {
    const session = requireSession(this.store, sessionId);
    const after = normalizeCursor(options.after);
    const bounds = this.store.getEventBounds(sessionId);
    const throughSeq = Math.max(session.lastEventSeq, bounds.lastSeq);
    const firstRetained = retainedFirstSeq(bounds.firstSeq, throughSeq, this.eventRetentionLimit);
    if (after > throughSeq || after < firstRetained - 1) {
      const snapshot = this.store.getSnapshot(sessionId);
      return { gap: true, snapshot, events: [], throughSeq: snapshot.throughSeq };
    }
    const events = this.store.listEvents(sessionId, {
      after,
      limit: this.eventRetentionLimit
    });
    return { gap: false, events, throughSeq };
  }

  subscribe(sessionId, listener) { return this.eventHub.subscribe(sessionId, listener); }

  waitForRecovery() { return this.recovery.waitForAll(); }

  observePublishedEvent(event) {
    this.traceLifecycle.observePublishedEvent(event);
    if (this.queueAutomation) this.queueAutomation.observe(event);
  }

  async waitForActorIdle(sessionId) {
    await this.recovery.waitForSession(sessionId);
    const actor = await this.actors.acquire(requireSession(this.store, sessionId));
    await actor.waitForIdle();
  }

  async dispatchCommand(sessionId, command = {}) {
    await this.recovery.waitForSession(sessionId);
    const session = requireSession(this.store, sessionId);
    const commandId = String(command.commandId || '').trim();
    const trace = this.traceLifecycle.start({ provider: session.provider, sessionId, commandId });
    trace.mark('actorDequeued');
    try {
      const actor = await this.actors.acquire(session);
      trace.mark('runtimeAcquired');
      const result = await actor.dispatch({ ...command, sessionId, trace });
      if (result.duplicate || !trace.isRunBound()) {
        trace.finish({ status: result.duplicate ? 'duplicate' : 'completed' });
      }
      return { sessionId, ...result };
    } catch (error) {
      trace.finish({
        status: 'failed',
        errorCode: String(error && error.code || 'chat_command_failed')
      });
      throw error;
    }
  }

  async getCommandCatalog(sessionId) {
    const session = requireSession(this.store, sessionId);
    if (!this.catalog || typeof this.catalog.list !== 'function') return [];
    return this.catalog.list(session);
  }

  async readComposerCatalog(sessionId) {
    await this.recovery.waitForSession(sessionId);
    const session = requireSession(this.store, sessionId);
    const actor = await this.actors.acquire(session);
    const catalog = await actor.readComposerCatalog();
    return { sessionId: session.sessionId, ...catalog };
  }

  async readArtifact(artifactId) {
    if (!this.artifactReader || typeof this.artifactReader.read !== 'function') return null;
    return this.artifactReader.read(String(artifactId || '').trim());
  }

  close() {
    this.queueAutomation.close();
    this.actors.close();
    this.traceLifecycle.close();
    if (this.ownsStore) this.store.close();
  }
}

function createChatRuntimeService(options = {}) {
  const ownsStore = !options.store;
  const store = options.store || openChatRuntimeStore(options.storeOptions || {});
  return new ChatRuntimeService({
    ...options,
    ownsStore,
    store,
    eventHub: options.eventHub || new ChatRuntimeEventHub(),
    runtimeResolver: options.runtimeResolver
      || new DefaultProviderRuntimeResolver(options.runtimeResolverOptions),
    idFactory: options.idFactory || (options.storeOptions && options.storeOptions.idFactory),
    eventRetentionLimit: boundedLimit(options.eventRetentionLimit, DEFAULT_EVENT_RETENTION),
    traceFactory: options.traceFactory || ((attributes) => new ChatRuntimeTrace(attributes)),
    traceSink: options.traceSink || (() => {})
  });
}

module.exports = {
  ChatRuntimeService,
  createChatRuntimeService
};
