'use strict';

const { ChatRuntimeError } = require('./contracts');
const { withTransaction } = require('./database');
const { QUEUE_POLICIES, selectQueueLease } = require('./queue-lease-selector');
const { projectCanonicalQueueResult } = require('./queue-result-contract');
const { jsonText, mapQueueItem, requiredText } = require('./storage-utils');

const TERMINAL_STATES = new Set(['completed', 'failed']);
class QueueRepository {
  constructor(context, events) {
    this.context = context;
    this.events = events;
  }
  enqueue(sessionId, input = {}) {
    return withTransaction(this.context.db, () => {
      const commandId = requiredText(input.commandId, 'chat_queue_command_id_required');
      const policy = requiredText(input.policy, 'chat_queue_policy_required');
      if (!QUEUE_POLICIES.has(policy)) {
        throw new ChatRuntimeError('invalid_chat_queue_policy', 422);
      }
      const queueId = String(input.queueId || '').trim() || this.context.idFactory('queue');
      const now = this.context.clock();
      this.context.db.prepare(`
        INSERT INTO chat_runtime_queue (
          queue_id, session_id, command_id, position, policy, payload_json, state,
          lease_id, boundary_item_id, result_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'queued', NULL, NULL, NULL, ?, ?)
      `).run(
        queueId, sessionId, commandId, this.nextPosition(sessionId), policy,
        jsonText(input.payload), now, now
      );
      const item = this.get(queueId);
      this.appendEvent(sessionId, 'queue.item.added', { entry: item });
      return item;
    });
  }
  edit(queueId, patch = {}) {
    return withTransaction(this.context.db, () => {
      const item = this.requireQueued(queueId);
      const payload = { ...item.payload, ...structuredClone(patch) };
      this.context.db.prepare(`
        UPDATE chat_runtime_queue SET payload_json = ?, updated_at = ?
        WHERE queue_id = ? AND state = 'queued'
      `).run(jsonText(payload), this.context.clock(), queueId);
      const updated = this.get(queueId);
      this.appendEvent(item.sessionId, 'queue.item.updated', { entry: updated });
      return updated;
    });
  }
  remove(queueId) {
    return withTransaction(this.context.db, () => {
      const item = this.requireQueued(queueId);
      this.context.db.prepare(`
        DELETE FROM chat_runtime_queue WHERE queue_id = ? AND state = 'queued'
      `).run(queueId);
      this.appendEvent(item.sessionId, 'queue.item.removed', { queueId });
      return item;
    });
  }
  move(queueId, beforeQueueId) {
    return withTransaction(this.context.db, () => {
      const item = this.requireQueued(queueId);
      const before = beforeQueueId ? this.requireQueued(beforeQueueId) : null;
      if (before && before.sessionId !== item.sessionId) {
        throw new ChatRuntimeError('chat_queue_move_target_invalid', 409);
      }
      if (before && before.queueId === item.queueId) return item;
      const rows = this.list(item.sessionId).filter(({ status }) => status === 'queued');
      const orderedIds = reorderIds(rows, item.queueId, before && before.queueId);
      rewritePositions(this.context, rows, orderedIds);
      this.appendEvent(item.sessionId, 'queue.item.moved', movePayload(item, before));
      return this.get(queueId);
    });
  }
  lease(sessionId, input = {}) {
    return withTransaction(this.context.db, () => {
      const leaseId = requiredText(input.leaseId, 'chat_queue_lease_id_required');
      this.requireSession(sessionId);
      const selection = selectQueueLease(this.context.db, sessionId, input);
      const row = selection.row;
      if (!row) return null;
      const update = this.context.db.prepare(`
        UPDATE chat_runtime_queue
        SET state = 'leased', lease_id = ?, boundary_item_id = ?, updated_at = ?
        WHERE queue_id = ? AND state = 'queued'
      `).run(leaseId, selection.boundaryItemId, this.context.clock(), row.queue_id);
      if (!update.changes) return null;
      const item = this.get(row.queue_id);
      this.appendEvent(sessionId, 'queue.item.dispatched', { entry: item });
      return item;
    });
  }
  leaseNext(sessionId, input) { return this.lease(sessionId, input); }
  markRunning(queueId, leaseId) {
    return this.transition(queueId, leaseId, 'leased', 'running');
  }
  markRunningInTransaction(queueId, leaseId) {
    return this.transitionInTransaction(queueId, leaseId, 'leased', 'running');
  }

  settle(queueId, leaseId, outcome, result = {}) {
    validateOutcome(outcome);
    return this.transition(queueId, leaseId, 'running', outcome, result);
  }
  settleInTransaction(queueId, leaseId, outcome, result = {}) {
    validateOutcome(outcome);
    return this.transitionInTransaction(queueId, leaseId, 'running', outcome, result);
  }
  transition(queueId, leaseId, from, to, result) {
    return withTransaction(this.context.db, () => (
      this.transitionInTransaction(queueId, leaseId, from, to, result)
    ));
  }
  transitionInTransaction(queueId, leaseId, from, to, result) {
    const item = this.get(queueId);
    if (!item || item.status !== from || item.leaseId !== leaseId) {
      throw new ChatRuntimeError('invalid_queue_transition', 409, { from, to });
    }
    const persistedResult = TERMINAL_STATES.has(to)
      ? projectCanonicalQueueResult(to, result)
      : result;
    this.context.db.prepare(`
      UPDATE chat_runtime_queue SET state = ?, result_json = ?, updated_at = ?
      WHERE queue_id = ? AND state = ? AND lease_id = ?
    `).run(
      to, persistedResult === undefined ? null : jsonText(persistedResult), this.context.clock(),
      queueId, from, leaseId
    );
    const updated = this.get(queueId);
    this.appendEvent(updated.sessionId, 'queue.item.updated', { entry: updated });
    return updated;
  }
  list(sessionId, options = {}) {
    const active = options.activeOnly ? "AND state IN ('queued', 'leased', 'running')" : '';
    return this.context.db.prepare(`
      SELECT * FROM chat_runtime_queue WHERE session_id = ? ${active} ORDER BY position
    `).all(sessionId).map(mapQueueItem);
  }
  get(queueId) {
    return mapQueueItem(this.context.db.prepare(`
      SELECT * FROM chat_runtime_queue WHERE queue_id = ?
    `).get(queueId));
  }
  requireQueued(queueId) {
    const item = this.get(requiredText(queueId, 'chat_queue_id_required'));
    if (!item) throw new ChatRuntimeError('chat_queue_item_not_found', 404);
    if (item.status !== 'queued') {
      throw new ChatRuntimeError('chat_queue_item_not_queued', 409, { queueId });
    }
    return item;
  }
  requireSession(sessionId) {
    const row = this.context.db.prepare(`
      SELECT session_id FROM chat_runtime_sessions WHERE session_id = ?
    `).get(sessionId);
    if (!row) throw new ChatRuntimeError('chat_session_not_found', 404);
  }
  nextPosition(sessionId) {
    this.requireSession(sessionId);
    const row = this.context.db.prepare(`
      SELECT COALESCE(MAX(position), 0) + 1 AS position
      FROM chat_runtime_queue WHERE session_id = ?
    `).get(sessionId);
    return Number(row.position);
  }
  appendEvent(sessionId, type, payload) {
    this.events.appendInTransaction(sessionId, {
      type,
      source: { provider: 'aih', runtimeId: 'chat-runtime' },
      payload
    });
  }
}
function reorderIds(rows, queueId, beforeQueueId) {
  const ids = rows.map(({ queueId: id }) => id).filter((id) => id !== queueId);
  const index = beforeQueueId ? ids.indexOf(beforeQueueId) : ids.length;
  ids.splice(index < 0 ? ids.length : index, 0, queueId);
  return ids;
}
function rewritePositions(context, rows, orderedIds) {
  const positions = rows.map(({ position }) => position).sort((left, right) => left - right);
  const update = context.db.prepare(`
    UPDATE chat_runtime_queue SET position = ?, updated_at = ? WHERE queue_id = ?
  `);
  for (const row of rows) update.run(-row.position, context.clock(), row.queueId);
  orderedIds.forEach((queueId, index) => update.run(positions[index], context.clock(), queueId));
}
function movePayload(item, before) {
  return before ? { queueId: item.queueId, beforeQueueId: before.queueId }
    : { queueId: item.queueId };
}
function validateOutcome(outcome) {
  if (!TERMINAL_STATES.has(outcome)) {
    throw new ChatRuntimeError('invalid_queue_transition', 409, { outcome });
  }
}
module.exports = { QueueRepository };
