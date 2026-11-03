'use strict';

const { readTurnTimeline } = require('./timeline-settlement');

// Metrics belong to an accepted turn. Keep them in its existing durable record,
// then attach one aggregate to the final answer so pagination cannot multiply usage.
class TurnMetricsRepository {
  constructor(context, events) {
    this.context = context;
    this.events = events;
  }

  observeInTransaction(event) {
    if (!event.turnId || (!event.type.startsWith('timeline.item.') && event.type !== 'turn.metrics.updated')) return;
    const row = this.context.db.prepare(`
      SELECT state, active_turn_json FROM chat_runtime_sessions WHERE session_id = ?
    `).get(event.sessionId);
    const active = row?.active_turn_json ? JSON.parse(row.active_turn_json) : null;
    if (!active || active.turnId !== event.turnId) return;
    if (event.type === 'turn.metrics.updated') {
      const metrics = { ...event.payload.metrics };
      const baseline = active.usageTotals || this.previousUsageTotals(event);
      for (const field of ['inputTokens', 'outputTokens']) {
        const total = event.payload.totals?.[field];
        if (total === undefined || metrics[field] === undefined) continue;
        const previous = baseline[field];
        const delta = previous === undefined || total < previous ? metrics[field] : total - previous;
        if (delta === 0 && active.metrics?.[field] === undefined) delete metrics[field];
        else metrics[field] = (active.metrics?.[field] || 0) + delta;
      }
      active.usageTotals = { ...active.usageTotals, ...event.payload.totals };
      active.metrics = { ...active.metrics, ...metrics };
    } else {
      if (active.firstTokenAt !== undefined || !this.hasVisibleOutput(event)) return;
      active.firstTokenAt = Math.max(active.startedAt || event.at, event.at);
    }
    this.context.db.prepare('UPDATE chat_runtime_sessions SET active_turn_json = ? WHERE session_id = ?')
      .run(JSON.stringify(active), event.sessionId);
    this.events.appendInTransaction(event.sessionId, {
      type: 'turn.phase.changed', turnId: active.turnId, runId: active.runId,
      at: event.at, source: event.source, payload: { state: row.state, activeTurn: active }
    });
  }

  previousUsageTotals(event) {
    const previous = this.context.db.prepare(`
      SELECT payload_json FROM chat_runtime_events
      WHERE session_id = ? AND type = 'turn.metrics.updated' AND turn_id != ?
      ORDER BY seq DESC LIMIT 1
    `).get(event.sessionId, event.turnId);
    return previous ? JSON.parse(previous.payload_json).totals || {} : {};
  }

  hasVisibleOutput(event) {
    const item = event.payload.item;
    if (item) return isOutput(item) && Boolean(item.content?.trim());
    if (event.type !== 'timeline.item.delta' || !event.payload.chunk?.trim()) return false;
    const row = this.context.db.prepare(`
      SELECT payload_json FROM chat_runtime_events
      WHERE session_id = ? AND item_id = ? AND type IN ('timeline.item.started', 'timeline.item.updated', 'timeline.item.completed')
      ORDER BY seq DESC LIMIT 1
    `).get(event.sessionId, event.itemId);
    return row ? isOutput(JSON.parse(row.payload_json).item) : false;
  }

  finishInTransaction(sessionId, terminal) {
    const row = this.context.db.prepare('SELECT active_turn_json FROM chat_runtime_sessions WHERE session_id = ?').get(sessionId);
    const active = row?.active_turn_json ? JSON.parse(row.active_turn_json) : null;
    if (!active || active.turnId !== terminal?.turnId || active.startedAt === undefined) return;
    const completedAt = terminal.at ?? this.context.clock();
    const durationMs = Math.max(0, completedAt - active.startedAt);
    const ttftMs = active.firstTokenAt === undefined ? undefined
      : Math.min(durationMs, Math.max(0, active.firstTokenAt - active.startedAt));
    const metrics = { ...active.metrics, durationMs, ...(ttftMs === undefined ? {} : { ttftMs }) };
    const decodeMs = durationMs - (ttftMs || 0);
    if (ttftMs !== undefined && metrics.outputTokens > 0 && decodeMs >= 500) {
      metrics.tokensPerSec = metrics.outputTokens / (decodeMs / 1000);
    }
    const items = readTurnTimeline(this.context, sessionId, active.turnId);
    const answer = items.findLast((item) => item.kind === 'message' && item.detail.role === 'assistant');
    const reasoning = items.findLast((item) => item.kind === 'reasoning');
    const target = answer || reasoning;
    if (!target) return;
    const status = ['turn.failed', 'run.lost'].includes(terminal.type) ? 'failed'
      : terminal.type === 'turn.interrupted' ? 'cancelled' : 'completed';
    for (const item of items.filter(isOutput)) {
      if (item.id !== target.id && ['completed', 'failed', 'cancelled'].includes(item.status)) continue;
      const detail = { ...item.detail, ...(item.id === target.id ? { metrics } : {}) };
      this.events.appendInTransaction(sessionId, {
        type: 'timeline.item.completed', turnId: active.turnId, runId: active.runId,
        at: completedAt, source: terminal.source,
        payload: { item: { ...item, status, updatedAt: completedAt, detail } }
      }, { measureTurn: false });
    }
  }
}

function isOutput(item) {
  return item && (item.kind === 'reasoning' || item.kind === 'message' && item.detail?.role === 'assistant');
}

module.exports = { TurnMetricsRepository };
