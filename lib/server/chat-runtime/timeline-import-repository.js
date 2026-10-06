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
      const prepared = this.preserveMeasuredMetadata(id, draft);
      if (this.isStaleRepeat(id, prepared)) {
        skipped += 1;
        continue;
      }
      // Native history timestamps describe the turn, not observed first output.
      events.push(this.events.appendInTransaction(id, prepared, {
        measureTurn: false,
        toolHistoryIntegrity
      }));
    }
    return { events, skipped };
  }

  // 同一条 thread/read 历史在回合进行中先导入一次（updatedAt 只能退回开始时间），
  // 回合结束后再导入时只有 updatedAt 变了，内容哈希却因此不同——追加一整行副本
  // （实测 1.7 万个 item 各多存一份）。只在以下三点同时成立时视为已导入跳过：
  // 已有行是历史导入行、是该 item 最新的时间线行、两者仅 updatedAt 不同。
  // 其余情况（含实时运行写入的更新行）照旧追加，不改写事件日志。
  isStaleRepeat(sessionId, draft) {
    const item = draft?.payload?.item;
    if (!item || !String(draft.eventId || '').startsWith('history-')) return false;
    const latest = this.context.db.prepare(`
      SELECT event_id, type, payload_json FROM chat_runtime_events
      WHERE session_id = ? AND item_id = ? AND type LIKE 'timeline.item.%'
      ORDER BY seq DESC LIMIT 1
    `).get(sessionId, item.id);
    if (!latest || !String(latest.event_id).startsWith('history-') || latest.type !== draft.type) return false;
    return sameIgnoringUpdatedAt(JSON.parse(latest.payload_json), draft.payload);
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
        ...(measured.detail.inherited ? { inherited: true } : {}),
        ...(measured.detail.model ? { model: measured.detail.model } : {}),
        ...(measured.detail.metrics ? { metrics: measured.detail.metrics } : {}) }
    } } };
  }
}

// 存储行经过事件规范化，草稿没有：按键名排序后比较，不受字段顺序影响。
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sameIgnoringUpdatedAt(stored, incoming) {
  const strip = (payload) => {
    const { updatedAt: _updatedAt, ...item } = payload?.item || {};
    return stableJson({ ...payload, item });
  };
  return strip(stored) === strip(incoming);
}

function requiredText(value, code) {
  const text = String(value || '').trim();
  if (!text) throw new ChatRuntimeError(code, 422);
  return text;
}

module.exports = { TimelineImportRepository };
