'use strict';

const { ChatRuntimeError } = require('./contracts');
const { withTransaction } = require('./database');

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
      events.push(this.events.appendInTransaction(id, draft));
    }
    return { events, skipped };
  }

  findOwner(eventId) {
    const row = this.context.db.prepare(`
      SELECT session_id FROM chat_runtime_events WHERE event_id = ?
    `).get(eventId);
    return row ? String(row.session_id) : '';
  }
}

function requiredText(value, code) {
  const text = String(value || '').trim();
  if (!text) throw new ChatRuntimeError(code, 422);
  return text;
}

module.exports = { TimelineImportRepository };
