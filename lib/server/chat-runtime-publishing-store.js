'use strict';

const { ChatRuntimeError } = require('./chat-runtime/contracts');

const PUBLISH_PAGE_SIZE = 500;

class ChatRuntimePublishingStore {
  constructor(options) {
    this.store = options.store;
    this.eventHub = options.eventHub;
    this.onCommandPersisted = options.onCommandPersisted || (() => {});
    this.onEventPublished = options.onEventPublished || (() => {});
  }

  get context() { return this.store.context; }
  get sessions() { return this.store.sessions; }
  get queue() { return this.store.queue; }
  get interactions() { return this.store.interactions; }
  get attachments() { return this.store.attachments; }
  get recovery() { return this.store.recovery; }

  createSession(input) {
    const session = this.store.createSession(input);
    this.publishSince(session.sessionId, 0);
    return session;
  }

  getSession(sessionId) { return this.store.getSession(sessionId); }

  createAttachments(sessionId, inputs) {
    return this.store.createAttachments(sessionId, inputs);
  }

  resolveAttachmentPaths(sessionId, attachmentIds) {
    return this.store.resolveAttachmentPaths(sessionId, attachmentIds);
  }

  listSessions(query) {
    if (typeof this.store.listSessions !== 'function') return null;
    return this.store.listSessions(query);
  }

  updateRuntimeBinding(sessionId, patch) {
    return this.publishKnown(sessionId, () => this.store.updateRuntimeBinding(sessionId, patch));
  }

  updatePolicy(sessionId, patch) {
    return this.publishKnown(sessionId, () => this.store.updatePolicy(sessionId, patch));
  }

  setSessionState(sessionId, state, activeTurn) {
    return this.store.setSessionState(sessionId, state, activeTurn);
  }

  beginTurn(sessionId, input) {
    return this.publishKnown(sessionId, () => this.store.beginTurn(sessionId, input));
  }

  transitionTurnPhase(sessionId, input) {
    return this.publishKnown(
      sessionId,
      () => this.store.transitionTurnPhase(sessionId, input)
    );
  }

  updateActiveTurnAnchor(sessionId, input) {
    return this.store.updateActiveTurnAnchor(sessionId, input);
  }

  acceptCommand(input) {
    const result = this.store.acceptCommand(input);
    this.onCommandPersisted(input.commandId, input.trace);
    return result;
  }

  getCommand(commandId) { return this.store.getCommand(commandId); }

  completeCommand(commandId, status, result) {
    return this.store.completeCommand(commandId, status, result);
  }

  appendEvent(sessionId, draft) {
    const event = this.store.appendEvent(sessionId, draft);
    this.publish(event);
    return event;
  }

  importTimeline(sessionId, drafts) {
    return this.publishKnown(sessionId, () => this.store.importTimeline(sessionId, drafts));
  }

  listEvents(sessionId, options) { return this.store.listEvents(sessionId, options); }
  getEventBounds(sessionId) { return this.store.getEventBounds(sessionId); }

  enqueue(sessionId, input) {
    return this.publishKnown(sessionId, () => this.store.enqueue(sessionId, input));
  }

  editQueueItem(queueId, patch) {
    const sessionId = this.queueSessionId(queueId);
    return this.publishKnown(sessionId, () => this.store.editQueueItem(queueId, patch));
  }

  removeQueueItem(queueId) {
    const sessionId = this.queueSessionId(queueId);
    return this.publishKnown(sessionId, () => this.store.removeQueueItem(queueId));
  }

  moveQueueItem(queueId, beforeQueueId) {
    const sessionId = this.queueSessionId(queueId);
    return this.publishKnown(sessionId, () => (
      this.store.moveQueueItem(queueId, beforeQueueId)
    ));
  }

  leaseQueueItem(sessionId, input) {
    return this.publishKnown(sessionId, () => this.store.leaseQueueItem(sessionId, input));
  }

  leaseNextQueueItem(sessionId, input) {
    return this.publishKnown(sessionId, () => this.store.leaseNextQueueItem(sessionId, input));
  }

  markQueueRunning(queueId, leaseId) {
    const sessionId = this.queueSessionId(queueId);
    return this.publishKnown(sessionId, () => this.store.markQueueRunning(queueId, leaseId));
  }

  settleQueueItem(queueId, leaseId, outcome, result) {
    const sessionId = this.queueSessionId(queueId);
    return this.publishKnown(sessionId, () => (
      this.store.settleQueueItem(queueId, leaseId, outcome, result)
    ));
  }

  settleTurn(sessionId, input) {
    return this.publishKnown(sessionId, () => this.store.settleTurn(sessionId, input));
  }

  listQueue(sessionId, options) { return this.store.listQueue(sessionId, options); }
  listRecoveryCandidates() { return this.store.listRecoveryCandidates(); }

  beginRestartRecovery(sessionId) {
    return this.publishKnown(sessionId, () => this.store.beginRestartRecovery(sessionId));
  }

  completeRestartRecovery(sessionId, input) {
    return this.publishKnown(sessionId, () => (
      this.store.completeRestartRecovery(sessionId, input)
    ));
  }

  failRestartRecovery(sessionId, error) {
    return this.publishKnown(sessionId, () => this.store.failRestartRecovery(sessionId, error));
  }

  readRestartRecovery(sessionId) { return this.store.readRestartRecovery(sessionId); }

  createInteraction(input) {
    return this.publishKnown(input.sessionId, () => this.store.createInteraction(input));
  }

  validateInteraction(interactionId, input) {
    return this.store.validateInteraction(interactionId, input);
  }

  resolveInteraction(interactionId, input) {
    const sessionId = this.interactionSessionId(interactionId);
    return this.publishKnown(sessionId, () => this.store.resolveInteraction(interactionId, input));
  }

  claimInteractionResolution(interactionId, input) {
    const sessionId = this.interactionSessionId(interactionId);
    return this.publishKnown(sessionId, () => (
      this.store.claimInteractionResolution(interactionId, input)
    ));
  }

  finishInteractionResolution(claim) {
    const sessionId = this.interactionSessionId(claim.interactionId);
    return this.publishKnown(sessionId, () => (
      this.store.finishInteractionResolution(claim)
    ));
  }

  releaseInteractionResolution(claim) {
    const sessionId = this.interactionSessionId(claim.interactionId);
    return this.publishKnown(sessionId, () => (
      this.store.releaseInteractionResolution(claim)
    ));
  }

  acknowledgeExternalInteraction(interactionId) {
    const sessionId = this.interactionSessionId(interactionId);
    return this.publishKnown(sessionId, () => (
      this.store.acknowledgeExternalInteraction(interactionId)
    ));
  }

  getSnapshot(sessionId) { return this.store.getSnapshot(sessionId); }
  readTimeline(sessionId, options) { return this.store.readTimeline(sessionId, options); }
  close() { return this.store.close(); }

  publishKnown(sessionId, operation) {
    const session = sessionId && this.store.getSession(sessionId);
    const after = session ? session.lastEventSeq : 0;
    const result = operation();
    if (sessionId) this.publishSince(sessionId, after);
    return result;
  }

  publishSince(sessionId, after) {
    const session = this.store.getSession(sessionId);
    if (!session) return 0;
    const through = Number(session.lastEventSeq);
    let cursor = Math.max(0, Number(after) || 0);
    let published = 0;
    while (cursor < through) {
      const events = this.store.listEvents(sessionId, {
        after: cursor,
        through,
        limit: PUBLISH_PAGE_SIZE
      });
      if (events.length === 0) {
        throw publishSequenceError(sessionId, cursor + 1, through);
      }
      for (const event of events) {
        const seq = Number(event.seq);
        if (seq !== cursor + 1 || seq > through) {
          throw publishSequenceError(sessionId, cursor + 1, through, seq);
        }
        this.publish(event);
        cursor = seq;
        published += 1;
      }
    }
    return published;
  }

  publish(event) {
    this.eventHub.publish(event);
    this.onEventPublished(event);
  }

  queueSessionId(queueId) {
    const item = this.store.queue && this.store.queue.get(queueId);
    return item && item.sessionId;
  }

  interactionSessionId(interactionId) {
    const item = this.store.interactions && this.store.interactions.get(interactionId);
    return item && item.sessionId;
  }
}

function publishSequenceError(sessionId, expectedSeq, throughSeq, actualSeq) {
  return new ChatRuntimeError('chat_runtime_publish_sequence_gap', 500, {
    sessionId,
    expectedSeq,
    throughSeq,
    ...(actualSeq === undefined ? {} : { actualSeq })
  });
}

module.exports = { ChatRuntimePublishingStore };
