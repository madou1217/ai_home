'use strict';

const { ChatRuntimeError } = require('./contracts');
const { withTransaction } = require('./database');

// Exact live ThreadItem identity complements raw Responses identity. Legacy
// history may rewrite message IDs, so it cannot reconstruct this association.
class NativeThreadItemRepository {
  constructor(store) { this.store = store; this.context = store.context; }

  record(sessionId, evidence) {
    return withTransaction(this.context.db, () => {
      this.store.nativeResponseItems.requireThread(sessionId, evidence.threadId);
      this.recordInTransaction(sessionId, evidence);
    });
  }

  recordInTransaction(sessionId, { threadId, turnId, item, rawMessageId = null }) {
    if (!turnId || !item?.id || !item.type) throw new ChatRuntimeError('chat_native_thread_item_invalid', 422);
    const existing = this.context.db.prepare(`SELECT * FROM chat_runtime_native_thread_items
      WHERE session_id = ? AND item_id = ?`).get(sessionId, item.id);
    if (existing && (existing.native_thread_id !== threadId || existing.native_turn_id !== turnId
      || JSON.parse(existing.item_json).type !== item.type
      || (existing.raw_message_id && rawMessageId && existing.raw_message_id !== rawMessageId))) {
      throw new ChatRuntimeError('chat_native_thread_item_conflict', 409);
    }
    if (rawMessageId) {
      const raw = this.store.nativeResponseItems.readRow(sessionId, rawMessageId);
      if (item.type !== 'userMessage' || raw?.native_thread_id !== threadId || raw?.native_turn_id !== turnId
        || JSON.parse(raw.response_item_json).role !== 'user') throw new ChatRuntimeError('chat_native_message_link_invalid', 409);
      const other = this.context.db.prepare(`SELECT item_id FROM chat_runtime_native_thread_items
        WHERE session_id = ? AND raw_message_id = ? AND item_id != ?`).get(sessionId, rawMessageId, item.id);
      if (other) throw new ChatRuntimeError('chat_native_message_link_conflict', 409);
    }
    this.context.db.prepare(`INSERT INTO chat_runtime_native_thread_items
      (session_id, native_thread_id, native_turn_id, item_id, item_json, raw_message_id, ordinal)
      VALUES (?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(ordinal), 0) + 1 FROM chat_runtime_native_thread_items WHERE session_id = ?))
      ON CONFLICT(session_id, item_id) DO UPDATE SET item_json = excluded.item_json,
        raw_message_id = COALESCE(excluded.raw_message_id, raw_message_id)`)
      .run(sessionId, threadId, turnId, item.id, JSON.stringify(item), rawMessageId, sessionId);
  }

  readTurn(sessionId, threadId, turnId) {
    return this.context.db.prepare(`SELECT item_json, raw_message_id FROM chat_runtime_native_thread_items
      WHERE session_id = ? AND native_thread_id = ? AND native_turn_id = ? ORDER BY ordinal`)
      .all(sessionId, threadId, turnId).map((row) => ({ item: JSON.parse(row.item_json), rawMessageId: row.raw_message_id }));
  }
}

module.exports = { NativeThreadItemRepository };
