'use strict';

const { ChatRuntimeError } = require('./contracts');
const { isDeepStrictEqual } = require('node:util');
const { withTransaction } = require('./database');

// Private execution evidence, separate from public timeline/SSE projection.
// Preserve the wire shape, including opaque future types. Consumers separately
// prove reversibility; storing a record does not claim it is safe to inject.
class NativeResponseItemRepository {
  constructor(context, sessions) { this.context = context; this.sessions = sessions; }

  record(sessionId, evidence) {
    return withTransaction(this.context.db, () => {
      this.requireThread(sessionId, evidence.threadId);
      return this.recordInTransaction(sessionId, evidence);
    });
  }

  recordInTransaction(sessionId, { threadId, turnId = '', item }) {
    if (!item || Array.isArray(item) || typeof item.type !== 'string' || !item.type.trim()
      || typeof item.id !== 'string' || !item.id.trim()
      || item.type === 'reasoning' && (!Array.isArray(item.summary)
        || item.encrypted_content !== undefined && item.encrypted_content !== null
          && typeof item.encrypted_content !== 'string')) {
      throw new ChatRuntimeError('chat_native_history_item_invalid', 422);
    }
    const previous = this.readRow(sessionId, item.id);
    const serialized = JSON.stringify(item);
    if (previous) {
      if (!isDeepStrictEqual(JSON.parse(previous.response_item_json), item)
        || previous.native_thread_id !== threadId
        || previous.native_turn_id !== turnId) {
        throw new ChatRuntimeError('chat_native_history_item_conflict', 409);
      }
      return;
    }
    this.context.db.prepare(`INSERT INTO chat_runtime_native_response_items
      (session_id, item_id, native_thread_id, native_turn_id, ordinal, response_item_json)
      VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(ordinal), 0) + 1
        FROM chat_runtime_native_response_items WHERE session_id = ?), ?)`)
      .run(sessionId, item.id, threadId, turnId, sessionId, serialized);
  }

  read(sessionId, itemId) {
    const row = this.readRow(sessionId, itemId);
    return row ? JSON.parse(row.response_item_json) : null;
  }

  readRow(sessionId, itemId) {
    return this.context.db.prepare(`SELECT * FROM chat_runtime_native_response_items
      WHERE session_id = ? AND item_id = ?`).get(sessionId, itemId);
  }

  readTurn(sessionId, threadId, turnId) {
    if (!threadId || !turnId) throw new ChatRuntimeError('chat_native_history_turn_required', 422);
    return this.context.db.prepare(`SELECT response_item_json FROM chat_runtime_native_response_items
      WHERE session_id = ? AND native_thread_id = ? AND native_turn_id = ? AND ordinal IS NOT NULL
      ORDER BY ordinal`).all(sessionId, threadId, turnId).map((row) => JSON.parse(row.response_item_json));
  }

  markCoverage(sessionId, { threadId, turnId, boundary }) {
    return withTransaction(this.context.db, () => {
      this.requireThread(sessionId, threadId);
      if (!turnId || !['started', 'completed', 'gap'].includes(boundary)) {
        throw new ChatRuntimeError('chat_native_history_boundary_invalid', 422);
      }
      const previous = this.coverage(sessionId, threadId, turnId);
      const captured = this.context.db.prepare(`SELECT 1 FROM chat_runtime_native_response_items
        WHERE session_id = ? AND native_thread_id = ? AND native_turn_id = ? AND ordinal IS NOT NULL LIMIT 1`)
        .get(sessionId, threadId, turnId);
      // A terminal event after a process restart or reconnect cannot certify
      // the notifications lost before it. A gap is sticky for this exact turn.
      const state = boundary === 'gap' ? 'incomplete'
        : boundary === 'started' ? previous || 'recording'
          : captured && (previous === 'recording' || previous === 'complete') ? 'complete' : 'incomplete';
      this.context.db.prepare(`INSERT INTO chat_runtime_native_history_coverage
        (session_id, native_thread_id, native_turn_id, state) VALUES (?, ?, ?, ?)
        ON CONFLICT(session_id, native_thread_id, native_turn_id) DO UPDATE SET state = excluded.state`)
        .run(sessionId, threadId, turnId, state);
      return state;
    });
  }

  coverage(sessionId, threadId, turnId) {
    return this.context.db.prepare(`SELECT state FROM chat_runtime_native_history_coverage
      WHERE session_id = ? AND native_thread_id = ? AND native_turn_id = ?`)
      .get(sessionId, threadId, turnId)?.state || null;
  }

  requireThread(sessionId, threadId) {
    if (this.sessions.require(sessionId).runtimeBinding.nativeSessionId !== threadId) {
      throw new ChatRuntimeError('chat_native_history_thread_mismatch', 409);
    }
  }
}

module.exports = { NativeResponseItemRepository };
