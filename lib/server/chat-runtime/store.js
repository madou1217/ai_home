'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');

const { normalizeSnapshot } = require('./contracts');
const { AttachmentRepository } = require('./attachment-repository');
const { CommandRepository } = require('./command-repository');
const { openChatRuntimeDatabase, withTransaction } = require('./database');
const { EventRepository } = require('./event-repository');
const { InteractionRepository } = require('./interaction-repository');
const { QueueRepository } = require('./queue-repository');
const { RecoveryRepository } = require('./recovery-repository');
const { SessionRepository } = require('./session-repository');
const { TimelineImportRepository } = require('./timeline-import-repository');
const { projectTimeline } = require('./timeline-projector');

const INITIAL_TIMELINE_ITEM_LIMIT = 30;

class ChatRuntimeStore {
  constructor(context) {
    this.context = context;
    this.events = new EventRepository(context);
    this.sessions = new SessionRepository(context, this.events);
    this.attachments = new AttachmentRepository(context, this.sessions);
    this.commands = new CommandRepository(context);
    this.queue = new QueueRepository(context, this.events);
    this.interactions = new InteractionRepository(context, this.events);
    this.recovery = new RecoveryRepository(context, this.events);
    this.timelineImports = new TimelineImportRepository(context, this.events);
  }

  createSession(input) { return this.sessions.create(input); }
  resolveSession(input) { return this.sessions.resolve(input); }
  findSessionByNativeIdentity(input) {
    return this.sessions.findByNativeIdentity(input);
  }
  getSession(sessionId) { return this.sessions.get(sessionId); }
  listSessions(filters) { return this.sessions.list(filters); }
  updateRuntimeBinding(sessionId, patch) {
    return this.sessions.updateRuntimeBinding(sessionId, patch);
  }
  updateExecutionContext(sessionId, input) {
    return this.sessions.updateExecutionContext(sessionId, input);
  }
  updatePolicy(sessionId, patch) { return this.sessions.updatePolicy(sessionId, patch); }
  createAttachments(sessionId, inputs) {
    return this.attachments.createMany(sessionId, inputs);
  }
  resolveAttachmentPaths(sessionId, attachmentIds) {
    return this.attachments.resolvePaths(sessionId, attachmentIds);
  }
  setSessionState(sessionId, state, activeTurn) {
    return this.sessions.updateState(sessionId, state, activeTurn);
  }
  beginTurn(sessionId, input = {}) {
    return withTransaction(this.context.db, () => {
      this.sessions.updateState(sessionId, 'starting', input.activeTurn);
      const event = this.events.appendInTransaction(sessionId, input.event);
      const queue = input.queue
        ? this.queue.markRunningInTransaction(input.queue.queueId, input.queue.leaseId)
        : null;
      return { event, queue, session: this.sessions.require(sessionId) };
    });
  }
  transitionTurnPhase(sessionId, input = {}) {
    return withTransaction(this.context.db, () => {
      this.sessions.updateState(sessionId, input.state, input.activeTurn);
      const event = this.events.appendInTransaction(sessionId, input.event);
      return { event, session: this.sessions.require(sessionId) };
    });
  }
  updateActiveTurnAnchor(sessionId, input) {
    return this.sessions.updateActiveTurnAnchor(sessionId, input);
  }
  acceptCommand(input) { return this.commands.accept(input); }
  getCommand(commandId) { return this.commands.get(commandId); }
  completeCommand(commandId, status, result) {
    return this.commands.complete(commandId, status, result);
  }
  appendEvent(sessionId, draft) { return this.events.append(sessionId, draft); }
  importTimeline(sessionId, drafts) {
    return this.timelineImports.import(sessionId, drafts);
  }
  listEvents(sessionId, options) { return this.events.list(sessionId, options); }
  getEventBounds(sessionId) {
    this.sessions.require(sessionId);
    return this.events.getBounds(sessionId);
  }
  enqueue(sessionId, input) { return this.queue.enqueue(sessionId, input); }
  editQueueItem(queueId, patch) { return this.queue.edit(queueId, patch); }
  removeQueueItem(queueId) { return this.queue.remove(queueId); }
  moveQueueItem(queueId, beforeQueueId) { return this.queue.move(queueId, beforeQueueId); }
  leaseQueueItem(sessionId, input) { return this.queue.lease(sessionId, input); }
  leaseNextQueueItem(sessionId, input) { return this.queue.leaseNext(sessionId, input); }
  markQueueRunning(queueId, leaseId) { return this.queue.markRunning(queueId, leaseId); }
  settleQueueItem(queueId, leaseId, outcome, result) {
    return this.queue.settle(queueId, leaseId, outcome, result);
  }
  listQueue(sessionId, options) { return this.queue.list(sessionId, options); }
  listRecoveryCandidates() { return this.recovery.listCandidates(); }
  beginRestartRecovery(sessionId) { return this.recovery.begin(sessionId); }
  completeRestartRecovery(sessionId, input) {
    return this.recovery.complete(sessionId, input);
  }
  failRestartRecovery(sessionId, error) { return this.recovery.fail(sessionId, error); }
  readRestartRecovery(sessionId) { return this.recovery.describe(sessionId, true); }
  settleTurn(sessionId, input = {}) {
    return withTransaction(this.context.db, () => {
      this.sessions.updateState(sessionId, 'idle', null);
      this.recovery.expirePendingInTransaction(sessionId, 'turn_terminal');
      const queue = input.queue
        ? this.queue.settleInTransaction(
          input.queue.queueId,
          input.queue.leaseId,
          input.queue.outcome,
          input.queue.result
        )
        : null;
      const event = this.events.appendInTransaction(sessionId, input.event);
      return { event, queue, session: this.sessions.require(sessionId) };
    });
  }
  createInteraction(input) { return this.interactions.create(input); }
  validateInteraction(interactionId, input) {
    return this.interactions.validate(interactionId, input);
  }
  resolveInteraction(interactionId, input) {
    return this.interactions.resolve(interactionId, input);
  }
  claimInteractionResolution(interactionId, input) {
    return this.interactions.claimResolution(interactionId, input);
  }
  finishInteractionResolution(claim) {
    return this.interactions.finishResolution(claim);
  }
  releaseInteractionResolution(claim) {
    return this.interactions.releaseResolution(claim);
  }
  acknowledgeExternalInteraction(interactionId) {
    return this.interactions.acknowledgeExternal(interactionId);
  }

  readTimeline(sessionId, options = {}) {
    const session = this.sessions.require(sessionId);
    const limit = Math.min(100, Math.max(1, Number(options.limit) || 30));
    const page = this.events.readTimelinePage(sessionId, {
      before: options.before,
      limit
    });
    const items = projectTimeline(page.events);
    return {
      sessionId,
      items,
      hasMore: page.hasMore,
      nextBefore: page.hasMore && items[0] ? items[0].id : null,
      throughSeq: session.lastEventSeq
    };
  }

  getSnapshot(sessionId) {
    const session = this.sessions.require(sessionId);
    const tail = this.events.readTimelinePage(sessionId, {
      limit: INITIAL_TIMELINE_ITEM_LIMIT
    });
    const timeline = projectTimeline(tail.events);
    const timelineHasMore = tail.hasMore;
    const snapshot = {
      sessionId,
      state: session.state,
      throughSeq: session.lastEventSeq,
      policy: session.policy,
      queue: this.queue.list(sessionId, { activeOnly: true }),
      interactions: this.interactions.listActive(sessionId),
      timeline,
      timelineHasMore,
      timelineNextBefore: timelineHasMore && timeline[0] ? timeline[0].id : null
    };
    copyOptionalSnapshotFields(snapshot, session);
    return normalizeSnapshot(snapshot);
  }

  close() {
    if (!this.context.db) return;
    this.context.db.close();
    this.context.db = null;
  }
}

function copyOptionalSnapshotFields(snapshot, session) {
  if (Object.keys(session.runtimeBinding).length > 0) {
    snapshot.runtimeBinding = session.runtimeBinding;
  }
  if (Object.keys(session.capabilitySnapshot).length > 0) {
    snapshot.capabilitySnapshot = session.capabilitySnapshot;
  }
  if (session.activeTurn) snapshot.activeTurn = session.activeTurn;
}

function openChatRuntimeStore(options = {}) {
  const context = {
    db: openChatRuntimeDatabase({ ...options, fs: options.fs || fs }),
    clock: typeof options.clock === 'function' ? options.clock : Date.now,
    idFactory: typeof options.idFactory === 'function'
      ? options.idFactory
      : (prefix) => `${prefix}-${crypto.randomUUID()}`
  };
  return new ChatRuntimeStore(context);
}

module.exports = {
  ChatRuntimeStore,
  INITIAL_TIMELINE_ITEM_LIMIT,
  openChatRuntimeStore
};
