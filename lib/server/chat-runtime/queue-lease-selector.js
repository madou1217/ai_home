'use strict';

const { ChatRuntimeError } = require('./contracts');

const QUEUE_POLICIES = new Set(['after_tool_boundary', 'after_turn']);

function selectQueueLease(db, sessionId, input = {}) {
  const policy = optionalPolicy(input.policy);
  const boundaryItemId = optionalText(input.boundaryItemId);
  if (boundaryItemId && boundaryAlreadyUsed(db, sessionId, boundaryItemId)) {
    return { boundaryItemId, row: null };
  }
  const query = queueSelectionQuery(input.queueId, policy);
  return {
    boundaryItemId,
    row: db.prepare(query.sql).get(sessionId, ...query.values)
  };
}

function queueSelectionQuery(queueId, policy) {
  const conditions = ["state = 'queued'"];
  const values = [];
  if (queueId) {
    conditions.push('queue_id = ?');
    values.push(queueId);
  }
  if (policy) {
    conditions.push('policy = ?');
    values.push(policy);
  }
  return {
    sql: `SELECT * FROM chat_runtime_queue
      WHERE session_id = ? AND ${conditions.join(' AND ')}
      ORDER BY position LIMIT 1`,
    values
  };
}

function boundaryAlreadyUsed(db, sessionId, boundaryItemId) {
  return Boolean(db.prepare(`
    SELECT queue_id FROM chat_runtime_queue
    WHERE session_id = ? AND boundary_item_id = ? LIMIT 1
  `).get(sessionId, boundaryItemId));
}

function optionalPolicy(value) {
  if (value === undefined || value === null) return null;
  const policy = optionalText(value);
  if (!QUEUE_POLICIES.has(policy)) {
    throw new ChatRuntimeError('invalid_chat_queue_policy', 422);
  }
  return policy;
}

function optionalText(value) {
  const text = String(value || '').trim();
  return text || null;
}

module.exports = { QUEUE_POLICIES, selectQueueLease };
