'use strict';

const { ChatRuntimeError } = require('./contracts');
const {
  jsonText,
  mapInteraction,
  mapQueueItem,
  mapSession
} = require('./storage-utils');

class RecoveryStorage {
  constructor(context) {
    this.context = context;
  }

  listCandidates() {
    return this.context.db.prepare(`
      SELECT sessions.* FROM chat_runtime_sessions AS sessions
      WHERE sessions.active_turn_json IS NOT NULL
        OR EXISTS (
          SELECT 1 FROM chat_runtime_commands AS commands
          WHERE commands.session_id = sessions.session_id AND commands.status = 'accepted'
        )
        OR EXISTS (
          SELECT 1 FROM chat_runtime_queue AS queue
          WHERE queue.session_id = sessions.session_id
            AND queue.state IN ('leased', 'running')
        )
        OR EXISTS (
          SELECT 1 FROM chat_runtime_interactions AS interactions
          WHERE interactions.session_id = sessions.session_id
            AND interactions.state IN ('pending', 'resolving')
        )
      ORDER BY sessions.updated_at, sessions.session_id
    `).all().map(mapSession);
  }

  failAcceptedCommands(sessionId, result) {
    this.context.db.prepare(`
      UPDATE chat_runtime_commands
      SET status = 'failed', result_json = ?, updated_at = ?
      WHERE session_id = ? AND status = 'accepted'
    `).run(jsonText(result), this.context.clock(), sessionId);
  }

  resetResolvingInteractions(sessionId) {
    this.context.db.prepare(`
      UPDATE chat_runtime_interactions
      SET state = 'pending', resolution_json = NULL, updated_at = ?
      WHERE session_id = ? AND state = 'resolving'
    `).run(this.context.clock(), sessionId);
  }

  updateSession(sessionId, state, activeTurn) {
    this.context.db.prepare(`
      UPDATE chat_runtime_sessions SET state = ?, active_turn_json = ?, updated_at = ?
      WHERE session_id = ?
    `).run(
      state, activeTurn ? jsonText(activeTurn) : null,
      this.context.clock(), sessionId
    );
  }

  updateQueue(queue, state, result) {
    const clearLease = state === 'queued';
    this.context.db.prepare(`
      UPDATE chat_runtime_queue
      SET state = ?, lease_id = ?, boundary_item_id = ?, result_json = ?, updated_at = ?
      WHERE queue_id = ?
    `).run(
      state,
      clearLease ? null : queue.leaseId || null,
      clearLease ? null : queue.boundaryItemId || null,
      result ? jsonText(result) : null,
      this.context.clock(), queue.queueId
    );
    return this.getQueue(queue.queueId);
  }

  expireInteraction(interactionId, reason) {
    this.context.db.prepare(`
      UPDATE chat_runtime_interactions
      SET state = 'expired', resolution_json = ?, updated_at = ?
      WHERE interaction_id = ? AND state IN ('pending', 'resolving')
    `).run(jsonText({ reason }), this.context.clock(), interactionId);
    return this.getInteraction(interactionId);
  }

  activeQueue(sessionId) {
    const queues = this.activeQueues(sessionId);
    if (queues.length > 1) {
      throw new ChatRuntimeError('chat_recovery_queue_ambiguous', 409, { sessionId });
    }
    return queues[0] || null;
  }

  activeQueues(sessionId) {
    return this.context.db.prepare(`
      SELECT * FROM chat_runtime_queue
      WHERE session_id = ? AND state IN ('leased', 'running') ORDER BY position
    `).all(sessionId).map(mapQueueItem);
  }

  pendingInteractions(sessionId) {
    return this.context.db.prepare(`
      SELECT * FROM chat_runtime_interactions
      WHERE session_id = ? AND state IN ('pending', 'resolving')
      ORDER BY created_at, interaction_id
    `).all(sessionId).map(mapInteraction);
  }

  getQueue(queueId) {
    return mapQueueItem(this.context.db.prepare(`
      SELECT * FROM chat_runtime_queue WHERE queue_id = ?
    `).get(queueId));
  }

  getInteraction(interactionId) {
    return mapInteraction(this.context.db.prepare(`
      SELECT * FROM chat_runtime_interactions WHERE interaction_id = ?
    `).get(interactionId));
  }

  requireSession(sessionId) {
    const session = mapSession(this.context.db.prepare(`
      SELECT * FROM chat_runtime_sessions WHERE session_id = ?
    `).get(sessionId));
    if (!session) throw new ChatRuntimeError('chat_session_not_found', 404);
    return session;
  }

  requireActiveSession(sessionId) {
    const session = this.requireSession(sessionId);
    if (!session.activeTurn) throw new ChatRuntimeError('chat_recovery_turn_missing', 409);
    return session;
  }
}

module.exports = { RecoveryStorage };
