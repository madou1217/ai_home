'use strict';

const { withTransaction } = require('./database');
const {
  sanitizeCanonicalDiagnostic,
  sanitizeDiagnosticDetails
} = require('./canonical-diagnostic-sanitizer');
const { RecoveryStorage } = require('./recovery-storage');

class RecoveryRepository {
  constructor(context, events) {
    this.context = context;
    this.events = events;
    this.storage = new RecoveryStorage(context);
  }

  listCandidates() { return this.storage.listCandidates(); }

  begin(sessionId) {
    return withTransaction(this.context.db, () => {
      this.storage.resetResolvingInteractions(sessionId);
      const session = this.storage.requireSession(sessionId);
      this.storage.failAcceptedCommands(sessionId, restartFailure());
      if (!session.activeTurn) return this.convergeOrphans(session);
      const activeTurn = { ...session.activeTurn, state: 'recovering' };
      this.storage.updateSession(sessionId, 'recovering', activeTurn);
      this.appendRunEvent(session, activeTurn, 'run.detached', {
        reason: 'server_restart'
      });
      return this.describe(sessionId, true);
    });
  }

  complete(sessionId, input = {}) {
    return withTransaction(this.context.db, () => {
      const session = this.storage.requireActiveSession(sessionId);
      const queue = this.storage.activeQueue(sessionId);
      if (queue && queue.status === 'leased') this.updateQueue(queue, 'running');
      const interactions = this.storage.pendingInteractions(sessionId);
      const state = interactions.length > 0 ? 'waiting_input' : 'running';
      const activeTurn = {
        ...session.activeTurn,
        state,
        ...(input.nativeTurnId ? { nativeTurnId: String(input.nativeTurnId) } : {})
      };
      this.storage.updateSession(sessionId, state, activeTurn);
      this.appendRunEvent(session, activeTurn, 'run.reattached', {
        state,
        ...(activeTurn.nativeTurnId ? { nativeTurnId: activeTurn.nativeTurnId } : {})
      });
      return this.describe(sessionId, true);
    });
  }

  fail(sessionId, error = {}) {
    return withTransaction(this.context.db, () => {
      const session = this.storage.requireSession(sessionId);
      const activeTurn = session.activeTurn;
      this.storage.failAcceptedCommands(sessionId, restartFailure());
      this.failActiveQueues(sessionId, error);
      this.expirePendingInTransaction(sessionId, 'run_lost');
      this.storage.updateSession(sessionId, session.state === 'closed' ? 'closed' : 'idle', null);
      if (activeTurn) this.appendRunEvent(session, activeTurn, 'run.lost', {
        error: normalizeError(error)
      });
      return this.storage.requireSession(sessionId);
    });
  }

  describe(sessionId, recoverable = false) {
    const session = this.storage.requireSession(sessionId);
    return {
      recoverable,
      session,
      activeTurn: session.activeTurn || null,
      queue: this.storage.activeQueue(sessionId),
      interactions: this.storage.pendingInteractions(sessionId)
    };
  }

  expirePendingInTransaction(sessionId, reason) {
    const interactions = this.storage.pendingInteractions(sessionId);
    for (const interaction of interactions) {
      const expired = this.storage.expireInteraction(interaction.interactionId, reason);
      this.events.appendInTransaction(sessionId, interactionEvent(expired));
    }
    return interactions.length;
  }

  convergeOrphans(session) {
    const queues = this.storage.activeQueues(session.sessionId);
    for (const queue of queues) {
      if (queue.status === 'leased') this.updateQueue(queue, 'queued', null);
      else this.updateQueue(queue, 'failed', restartFailure());
    }
    const expired = this.expirePendingInTransaction(session.sessionId, 'run_lost');
    const lost = session.state !== 'idle' || queues.length > 0 || expired > 0;
    const state = session.state === 'closed' ? 'closed' : 'idle';
    this.storage.updateSession(session.sessionId, state, null);
    if (lost) this.appendRunEvent(session, null, 'run.lost', {
      error: restartFailure()
    });
    return this.describe(session.sessionId, false);
  }

  failActiveQueues(sessionId, error) {
    for (const queue of this.storage.activeQueues(sessionId)) {
      this.updateQueue(queue, 'failed', normalizeError(error));
    }
  }

  updateQueue(queue, state, result) {
    const updated = this.storage.updateQueue(queue, state, result);
    this.events.appendInTransaction(queue.sessionId, queueEvent(updated));
    return updated;
  }

  appendRunEvent(session, activeTurn, type, payload) {
    this.events.appendInTransaction(session.sessionId, {
      type,
      ...(activeTurn && activeTurn.turnId ? { turnId: activeTurn.turnId } : {}),
      ...(activeTurn && activeTurn.runId ? { runId: activeTurn.runId } : {}),
      source: runtimeSource(session),
      payload
    });
  }
}

function queueEvent(entry) {
  return {
    type: 'queue.item.updated',
    source: { provider: 'aih', runtimeId: 'chat-runtime' },
    payload: { entry }
  };
}

function interactionEvent(interaction) {
  return {
    type: 'interaction.expired',
    itemId: interaction.itemId,
    source: { provider: 'aih', runtimeId: 'chat-runtime' },
    payload: { interaction }
  };
}

function restartFailure() {
  return {
    code: 'chat_command_interrupted_by_restart',
    message: 'Command outcome is unknown after server restart'
  };
}

function normalizeError(error) {
  const projected = sanitizeCanonicalDiagnostic(error, {
    fallbackCode: 'chat_run_lost',
    fallbackMessage: 'Run could not be recovered'
  });
  return {
    ...projected,
    ...(error && error.nativeCleanup
      ? { nativeCleanup: sanitizeDiagnosticDetails(error.nativeCleanup) }
      : {})
  };
}

function runtimeSource(session) {
  return {
    provider: session.provider,
    runtimeId: String(session.runtimeBinding.runtimeId || 'unbound')
  };
}

module.exports = { RecoveryRepository };
