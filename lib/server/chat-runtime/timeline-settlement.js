'use strict';

const { projectTimeline } = require('./timeline-projector');

const OPEN_STATUSES = new Set(['pending', 'running', 'waiting_input']);
const EXECUTION_KINDS = new Set(['tool', 'shell', 'file_change', 'subagent', 'command', 'terminal']);

function readTurnTimeline(context, sessionId, turnId) {
  const rows = context.db.prepare(`
    SELECT type, payload_json FROM chat_runtime_events
    WHERE session_id = ? AND turn_id = ? AND type LIKE 'timeline.item.%' ORDER BY seq
  `).all(sessionId, turnId);
  return projectTimeline(rows.map((row) => ({ type: row.type, payload: JSON.parse(row.payload_json) })));
}

// DSH aa8262ec core/session/src/repair.ts distinguishes an unstarted call from
// an unknown result. Native notifications are observations, not a pre-execution
// barrier: AIH cannot prove "not started" and must never manufacture a result.
function settleTimelineItem(item, terminalType, at) {
  if (!OPEN_STATUSES.has(item.status)) return item;
  const status = EXECUTION_KINDS.has(item.kind) ? 'unknown'
    : terminalType === 'turn.completed' ? 'completed'
      : terminalType === 'turn.interrupted' ? 'cancelled' : 'failed';
  return { ...item, status, updatedAt: at };
}

function settleTurnTimeline(context, events, sessionId, terminal) {
  let outcomeUnknown = false;
  for (const item of readTurnTimeline(context, sessionId, terminal.turnId)) {
    const settled = settleTimelineItem(item, terminal.type, terminal.at ?? context.clock());
    outcomeUnknown ||= settled.status === 'unknown';
    if (settled === item) continue;
    events.appendInTransaction(sessionId, {
      type: 'timeline.item.completed', turnId: terminal.turnId, runId: terminal.runId,
      at: settled.updatedAt, source: terminal.source, payload: { item: settled }
    }, { measureTurn: false });
  }
  return outcomeUnknown;
}

module.exports = { OPEN_STATUSES, readTurnTimeline, settleTimelineItem, settleTurnTimeline };
