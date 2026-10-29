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
const { ChatSessionCoordinator } = require('./chat-runtime/chat-session-coordinator');
const { createChatRuntimeExtensionPipeline } = require('./chat-runtime/chat-runtime-extension-pipeline');
const { isChatSession } = require('./chat-runtime/chat-harness-policy');
const { prepareNativeBranch } = require('./chat-runtime/native-branch-operation');
const { ChatRuntimeError } = require('./chat-runtime/contracts');
const { refreshSlashCapabilities } = require('./chat-runtime/session-capabilities');

const DEFAULT_EVENT_RETENTION = 500;
// 只有静止状态可以删除：运行中的会话先停止（turn.interrupt）再删，避免把活的 harness 事务
// 半途拆掉（行删了、运行中的回写还在进行，事件/命令会永久性对不上）。
const DELETABLE_SESSION_STATES = new Set(['idle', 'closed']);

class ChatRuntimeService {
  constructor(options) {
    this.eventHub = options.eventHub;
    this.ownsStore = options.ownsStore;
    this.catalog = options.catalog;
    // Share the background catalog read with the first composer request.
    this.composerCatalogTasks = new Map();
    this.composerCatalogCache = new Map();
    this.artifactReader = options.artifactReader;
    this.extensions = createChatRuntimeExtensionPipeline({
      extensions: options.extensions,
      onObserverError: options.extensionObserverErrorSink
    });
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
      commandHandlers: {
        'session.fork': (context) => this.branchChatSession(context),
        'turn.regenerate': (context) => this.branchChatSession(context)
      },
      extensions: this.extensions,
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
    this.chatSessions = new ChatSessionCoordinator(this, options);
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

  async resolveSession(input = {}) {
    const result = await this.sessionResolver.resolve(input);
    const session = result && result.session;
    const capabilities = refreshSlashCapabilities(session);
    if (capabilities === session?.capabilitySnapshot) return result;
    return {
      ...result,
      session: this.store.updateCapabilitySnapshot(session.sessionId, capabilities)
    };
  }
  async openChatSession(input = {}) {
    const session = await this.chatSessions.open(input);
    const capabilities = refreshSlashCapabilities(session);
    if (capabilities !== session.capabilitySnapshot) {
      return this.store.updateCapabilitySnapshot(session.sessionId, capabilities);
    }
    return session;
  }

  async branchChatSession({ command, historyBranch }) {
    const child = isChatSession(this.store.getSession(command.sessionId))
      ? this.store.branchSession(command) : await this.branchWorkSession(command, historyBranch);
    if (command.type === 'turn.regenerate') {
      const commandId = `${command.commandId}:generate`;
      // Once submitted, recovery belongs to the child turn. Replaying the
      // parent's operation must not create another model request after a crash.
      if (!this.store.getCommand(commandId)) {
        await this.dispatchCommand(child.sessionId, { commandId,
          type: 'turn.submit', payload: this.store.readHistorySeed(child.sessionId).regeneration });
      }
    }
    return { session: this.store.getSession(child.sessionId) };
  }

  async branchWorkSession(command, historyBranch) {
    const store = this.store.store;
    const existing = store.workBranches.existing(command);
    if (existing) return existing;
    if (!historyBranch) throw new ChatRuntimeError('chat_branch_mode_unsupported', 422);
    const operation = store.branchOperations.read(command.sessionId, command.commandId);
    const plan = operation?.plan || await historyBranch.plan(command, store.workBranches.capture(command));
    await prepareNativeBranch({ repository: store.branchOperations, command, plan, native: historyBranch.native() });
    const child = store.workBranches.commit(command);
    this.store.publishSince(child.sessionId, 0);
    return child;
  }

  listSessions(query = {}) { return this.store.listSessions(query) || []; }

  /**
   * 物理删除会话（用户看到的「删除对话」）：静止态才允许；先释放常驻 actor（否则 harness
   * 进程在内存里成为孤儿），再删主行（子表级联），附件文件由 store 做 best-effort 清理，
   * 最后清掉 legacy 导入来源文件——只删 canonical 行的话，聊天列表会「复活」导入前的旧条目。
   */
  async deleteSession(sessionId) {
    const session = requireSession(this.store, sessionId);
    if (!DELETABLE_SESSION_STATES.has(session.state)) {
      throw new ChatRuntimeError('chat_session_busy', 409, { state: session.state });
    }
    this.actors.dispose(sessionId);
    this.composerCatalogTasks.delete(sessionId);
    this.composerCatalogCache.delete(sessionId);
    const deleted = this.store.deleteSession(sessionId);
    this.chatSessions.cleanupLegacySource(deleted);
    return { sessionId: deleted.sessionId, provider: deleted.provider };
  }

  getSnapshot(sessionId) {
    requireSession(this.store, sessionId);
    // Reads remain side-effect free: acquiring a missing actor can bind a
    // runtime and update the session activity clock. Capability snapshots are
    // already persisted at creation, so a transcript read only returns data.
    return this.store.getSnapshot(sessionId);
  }
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
    this.extensions.observe(event, { sessionId: event.sessionId, source: 'runtime' });
    this.traceLifecycle.observePublishedEvent(event);
    if (this.queueAutomation) this.queueAutomation.observe(event);
  }

  observeTransientEvent(event) {
    this.extensions.observe(event, { sessionId: event.sessionId, source: 'runtime-transient' });
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
      if (['session.fork', 'turn.regenerate'].includes(command.type)) {
        const operation = this.store.store.branchOperations.read(sessionId, commandId);
        const accepted = this.store.getCommand(commandId);
        throw new ChatRuntimeError(error.code || 'chat_branch_failed', error.statusCode || 500, {
          ...error.details,
          commandRecovery: { commandId, disposition: operation || accepted?.status === 'completed'
            || accepted?.status === 'accepted' ? 'resume' : 'new_command' }
        });
      }
      throw error;
    }
  }

  async getCommandCatalog(sessionId) {
    const session = requireSession(this.store, sessionId);
    if (!this.catalog || typeof this.catalog.list !== 'function') return [];
    const actor = await this.actors.acquire(session);
    return this.catalog.list(session, { historyBranch: actor.supportsHistoryBranch() });
  }

  getSessionCapabilities(sessionId) {
    const session = requireSession(this.store, sessionId);
    const capabilities = this.actors.getCapabilities(sessionId);
    return capabilities || session.capabilitySnapshot || {};
  }

  async readComposerCatalog(sessionId) {
    await this.recovery.waitForSession(sessionId);
    const session = requireSession(this.store, sessionId);
    const key = session.sessionId;
    const cached = this.composerCatalogCache.get(key);
    if (cached && Date.now() - cached.updatedAt < 30_000) return cached.value;
    const existing = this.composerCatalogTasks.get(key);
    if (existing) return existing;
    const task = Promise.resolve()
      .then(async () => {
        const actor = await this.actors.acquire(session);
        const catalog = await actor.readComposerCatalog();
        const value = { sessionId: session.sessionId, ...catalog };
        this.composerCatalogCache.set(key, { updatedAt: Date.now(), value });
        return value;
      })
      .finally(() => {
        if (this.composerCatalogTasks.get(key) === task) this.composerCatalogTasks.delete(key);
      });
    this.composerCatalogTasks.set(key, task);
    return task;
  }

  prewarmComposerCatalog(sessionId) {
    return this.readComposerCatalog(sessionId);
  }

  async prewarmRecentComposerCatalogs(limit = 8) {
    const sessions = this.store.listSessions({ workspaceMode: 'chat', limit: Math.max(1, Math.min(32, limit)) });
    // Keep startup responsive while warming the most recently used sessions.
    for (let index = 0; index < sessions.length; index += 2) {
      await Promise.allSettled(sessions.slice(index, index + 2).map((session) => (
        this.prewarmComposerCatalog(session.sessionId)
      )));
    }
  }

  async readArtifact(artifactId) {
    if (!this.artifactReader || typeof this.artifactReader.read !== 'function') return null;
    return this.artifactReader.read(String(artifactId || '').trim());
  }

  close() {
    this.queueAutomation.close();
    this.actors.close();
    this.composerCatalogTasks.clear();
    this.composerCatalogCache.clear();
    this.extensions.close();
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
