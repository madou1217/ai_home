'use strict';

const { ChatRuntimeError } = require('./contracts');
const { withTransaction } = require('./database');
const { OPEN_STATUSES } = require('./timeline-settlement');
const { createToolHistoryIntegrityGuard } = require('./tool-history-integrity');

class TimelineImportRepository {
  constructor(context, events) {
    this.context = context;
    this.events = events;
  }

  import(sessionId, drafts) {
    if (!Array.isArray(drafts)) {
      throw new ChatRuntimeError('chat_history_events_invalid', 422);
    }
    return withTransaction(this.context.db, () => this.importInTransaction(sessionId, drafts));
  }

  importInTransaction(sessionId, drafts) {
    const id = requiredText(sessionId, 'chat_session_id_required');
    const session = this.context.db.prepare(`
      SELECT session_id FROM chat_runtime_sessions WHERE session_id = ?
    `).get(id);
    if (!session) throw new ChatRuntimeError('chat_session_not_found', 404);
    const toolHistoryIntegrity = createToolHistoryIntegrityGuard(this.context, id);
    toolHistoryIntegrity.assert(drafts);
    const events = [];
    let skipped = 0;
    for (const draft of drafts) {
      const eventId = requiredText(
        draft && draft.eventId,
        'chat_history_event_id_required'
      );
      const owner = this.findOwner(eventId);
      if (owner) {
        if (owner !== id) {
          throw new ChatRuntimeError('chat_history_event_conflict', 409, { eventId });
        }
        skipped += 1;
        continue;
      }
      // Native history timestamps describe the turn, not observed first output.
      events.push(this.events.appendInTransaction(id, this.preserveMeasuredMetadata(id, draft), {
        measureTurn: false,
        toolHistoryIntegrity
      }));
    }
    return { events, skipped };
  }

  findOwner(eventId) {
    const row = this.context.db.prepare(`
      SELECT session_id FROM chat_runtime_events WHERE event_id = ?
    `).get(eventId);
    return row ? String(row.session_id) : '';
  }

  preserveMeasuredMetadata(sessionId, draft) {
    const item = draft?.payload?.item;
    if (!item) return draft;
    const previous = this.context.db.prepare(`
      SELECT payload_json FROM chat_runtime_events WHERE session_id = ? AND item_id = ?
        AND type IN ('timeline.item.started', 'timeline.item.updated', 'timeline.item.completed')
      ORDER BY seq DESC LIMIT 1
    `).get(sessionId, item.id);
    if (!previous) return draft;
    const measured = JSON.parse(previous.payload_json).item;
    // Stale/incomplete history cannot erase a recorded outcome or resurrect a
    // settled item. An explicit result may resolve a previously unknown outcome.
    if (!OPEN_STATUSES.has(measured.status) && (OPEN_STATUSES.has(item.status) || item.status === 'unknown')) {
      return { ...draft, type: 'timeline.item.completed', turnId: measured.turnId, payload: { item: measured } };
    }
    return { ...draft, ...(measured.turnId ? { turnId: measured.turnId } : {}), payload: { item: {
      ...item, ...(measured.turnId ? { turnId: measured.turnId } : {}),
      ...(measured.detail.metrics ? { status: measured.status, updatedAt: measured.updatedAt } : {}),
      detail: { ...item.detail,
        ...(measured.detail.model ? { model: measured.detail.model } : {}),
        ...(measured.detail.metrics ? { metrics: measured.detail.metrics } : {}) }
    } } };
  }
}

function requiredText(value, code) {
  const text = String(value || '').trim();
  if (!text) throw new ChatRuntimeError(code, 422);
  return text;
}

module.exports = { TimelineImportRepository };
