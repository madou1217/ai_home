'use strict';

const { ChatRuntimeError, normalizeEvent } = require('./contracts');
const { withTransaction } = require('./database');
const { jsonText, parseJson } = require('./storage-utils');

class EventRepository {
  constructor(context) {
    this.context = context;
  }

  append(sessionId, draft) {
    return withTransaction(this.context.db, () => this.appendInTransaction(sessionId, draft));
  }

  appendInTransaction(sessionId, draft = {}) {
    if (['session.snapshot.reset', 'stream.error'].includes(draft.type)) {
      throw new ChatRuntimeError('chat_transport_event_not_persistable', 422, {
        type: draft.type
      });
    }
    const { db, clock, idFactory } = this.context;
    const session = db.prepare(`
      SELECT last_event_seq FROM chat_runtime_sessions WHERE session_id = ?
    `).get(sessionId);
    if (!session) throw new ChatRuntimeError('chat_session_not_found', 404);
    const seq = Number(session.last_event_seq) + 1;
    const event = normalizeEvent({
      ...draft,
      itemId: resolveDraftItemId(draft),
      eventId: draft.eventId || idFactory('event'),
      sessionId,
      seq,
      at: draft.at === undefined ? clock() : draft.at
    });
    db.prepare(`
      INSERT INTO chat_runtime_events (
        event_id, session_id, seq, schema, type, at, turn_id, run_id,
        item_id, source_json, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.eventId, event.sessionId, event.seq, event.schema, event.type, event.at,
      event.turnId || null, event.runId || null, event.itemId || null,
      jsonText(event.source), jsonText(event.payload)
    );
    db.prepare(`
      UPDATE chat_runtime_sessions SET last_event_seq = ?, updated_at = ? WHERE session_id = ?
    `).run(seq, event.at, sessionId);
    return event;
  }

  list(sessionId, options = {}) {
    const after = Math.max(0, Number(options.after) || 0);
    const limit = Math.min(1000, Math.max(1, Number(options.limit) || 100));
    const through = normalizeThrough(options.through);
    if (through !== null) {
      return this.context.db.prepare(`
        SELECT * FROM chat_runtime_events
        WHERE session_id = ? AND seq > ? AND seq <= ? ORDER BY seq LIMIT ?
      `).all(sessionId, after, through, limit).map(mapEvent);
    }
    return this.context.db.prepare(`
      SELECT * FROM chat_runtime_events
      WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT ?
    `).all(sessionId, after, limit).map(mapEvent);
  }

  listTail(sessionId, limit = 100) {
    const bounded = Math.min(1000, Math.max(1, Number(limit) || 100));
    return this.context.db.prepare(`
      SELECT * FROM (
        SELECT * FROM chat_runtime_events
        WHERE session_id = ? ORDER BY seq DESC LIMIT ?
      ) ORDER BY seq
    `).all(sessionId, bounded).map(mapEvent);
  }

  listAll(sessionId) {
    return this.context.db.prepare(`
      SELECT * FROM chat_runtime_events WHERE session_id = ? ORDER BY seq
    `).all(sessionId).map(mapEvent);
  }

  readTimelinePage(sessionId, options = {}) {
    const limit = Math.min(100, Math.max(1, Number(options.limit) || 30));
    const beforeSeq = this.resolveTimelineCursor(sessionId, options.before);
    const rows = this.context.db.prepare(`
      SELECT item_id, MIN(seq) AS first_seq
      FROM chat_runtime_events
      WHERE session_id = ? AND item_id IS NOT NULL AND type LIKE 'timeline.item.%'
      GROUP BY item_id
      HAVING ? IS NULL OR MIN(seq) < ?
      ORDER BY first_seq DESC LIMIT ?
    `).all(sessionId, beforeSeq, beforeSeq, limit + 1);
    const hasMore = rows.length > limit;
    const itemIds = rows.slice(0, limit).map((row) => row.item_id).filter(Boolean);
    if (itemIds.length === 0) return { events: [], hasMore };
    const placeholders = itemIds.map(() => '?').join(', ');
    const events = this.context.db.prepare(`
      SELECT * FROM chat_runtime_events
      WHERE session_id = ? AND item_id IN (${placeholders}) AND type LIKE 'timeline.item.%'
      ORDER BY seq
    `).all(sessionId, ...itemIds).map(mapEvent);
    return { events, hasMore };
  }

  resolveTimelineCursor(sessionId, before) {
    const cursor = String(before || '').trim();
    if (!cursor) return null;
    const row = this.context.db.prepare(`
      SELECT MIN(seq) AS first_seq FROM chat_runtime_events
      WHERE session_id = ? AND item_id = ? AND type LIKE 'timeline.item.%'
    `).get(sessionId, cursor);
    if (row.first_seq === null) {
      throw new ChatRuntimeError('chat_timeline_cursor_not_found', 400);
    }
    return Number(row.first_seq);
  }

  getBounds(sessionId) {
    const row = this.context.db.prepare(`
      SELECT MIN(seq) AS first_seq, MAX(seq) AS last_seq, COUNT(*) AS count
      FROM chat_runtime_events WHERE session_id = ?
    `).get(sessionId);
    return {
      firstSeq: row.first_seq === null ? null : Number(row.first_seq),
      lastSeq: row.last_seq === null ? 0 : Number(row.last_seq),
      count: Number(row.count)
    };
  }
}

function normalizeThrough(value) {
  if (value === null || value === undefined || value === '') return null;
  const through = Number(value);
  return Number.isSafeInteger(through) && through >= 0 ? through : null;
}

function resolveDraftItemId(draft) {
  if (draft.itemId !== undefined) return draft.itemId;
  const payload = draft.payload && typeof draft.payload === 'object' ? draft.payload : {};
  if (payload.item && typeof payload.item === 'object') return payload.item.id;
  return payload.itemId;
}

function mapEvent(row) {
  return normalizeEvent({
    schema: row.schema,
    eventId: row.event_id,
    sessionId: row.session_id,
    seq: Number(row.seq),
    type: row.type,
    at: Number(row.at),
    turnId: row.turn_id || undefined,
    runId: row.run_id || undefined,
    itemId: row.item_id || undefined,
    source: parseJson(row.source_json),
    payload: parseJson(row.payload_json)
  });
}

module.exports = { EventRepository };
