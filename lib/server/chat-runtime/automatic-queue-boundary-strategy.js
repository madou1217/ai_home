'use strict';

const TOOL_BOUNDARY_KINDS = new Set(['tool', 'shell', 'file_change', 'subagent']);
const TURN_TERMINAL_EVENTS = new Set([
  'turn.completed', 'turn.failed', 'turn.interrupted'
]);

class AutomaticQueueBoundaryStrategy {
  resolve(event, session) {
    return resolveToolBoundary(event, session) || resolveTurnTerminal(event, session);
  }
}

function resolveToolBoundary(event = {}, session = {}) {
  if (event.type !== 'timeline.item.completed' || !event.runId) return null;
  if (!session.activeTurn || session.activeTurn.runId !== event.runId) return null;
  const item = event.payload && event.payload.item || {};
  const boundaryItemId = String(event.itemId || item.id || '').trim();
  if (!boundaryItemId || !TOOL_BOUNDARY_KINDS.has(item.kind)) return null;
  return {
    type: 'tool_boundary',
    sessionId: event.sessionId,
    identity: boundaryItemId,
    boundaryItemId,
    policy: 'after_tool_boundary'
  };
}

function resolveTurnTerminal(event = {}, session = {}) {
  if (!TURN_TERMINAL_EVENTS.has(event.type) || !event.runId) return null;
  if (session.state !== 'idle' || session.activeTurn) return null;
  return {
    type: 'turn_terminal',
    sessionId: event.sessionId,
    identity: event.eventId,
    policy: 'after_turn'
  };
}

module.exports = { AutomaticQueueBoundaryStrategy };
