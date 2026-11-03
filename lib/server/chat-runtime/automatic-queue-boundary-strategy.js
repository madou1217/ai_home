'use strict';

const TOOL_BOUNDARY_KINDS = new Set(['tool', 'shell', 'file_change', 'subagent']);
class AutomaticQueueBoundaryStrategy {
  resolve(event, session) {
    return resolveToolBoundary(event, session) || resolveFollowUp(event, session);
  }
}

function resolveToolBoundary(event = {}, session = {}) {
  if (event.type !== 'timeline.item.completed' || !event.runId) return null;
  if (!session.activeTurn || session.activeTurn.runId !== event.runId) return null;
  if (!['running', 'waiting_input'].includes(session.state)) return null;
  const item = event.payload && event.payload.item || {};
  const boundaryItemId = String(event.itemId || item.id || '').trim();
  if (!boundaryItemId || !TOOL_BOUNDARY_KINDS.has(item.kind)) return null;
  return {
    type: 'tool_boundary',
    sessionId: event.sessionId,
    runId: event.runId,
    identity: boundaryItemId,
    boundaryItemId,
    policy: 'after_tool_boundary'
  };
}

function resolveFollowUp(event = {}, session = {}) {
  if (session.state !== 'idle' || session.activeTurn) return null;
  const control = session.policy?.queueControl;
  if (control?.paused || !control?.lastRunId) return null;
  // Pi polls follow-ups after the loop ends; also handle a request admitted
  // just after that boundary. DSH cancel(keepInbox) keeps work pending: a stop
  // or failure is never permission to launch the next queued request.
  const completed = event.type === 'turn.completed' && event.runId === control.lastRunId;
  const arrived = event.type === 'queue.item.added' && event.payload?.entry?.policy === 'after_turn';
  if (!completed && !arrived) return null;
  return {
    type: 'turn_terminal',
    sessionId: event.sessionId,
    identity: control.lastRunId,
    runId: control.lastRunId,
    policy: 'after_turn'
  };
}

module.exports = { AutomaticQueueBoundaryStrategy };
