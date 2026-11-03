const ACTIVE_EVENT_TYPES = new Set([
  'session:turn-started',
  'session:turn-updated',
  'session:file-changed'
]);

const STOP_EVENT_TYPES = new Set([
  'session:turn-completed',
  'session:turn-failed',
  'session:closed'
]);

const STOP_PHASES = new Set([
  'turn-completed',
  'turn-failed',
  'session-closed'
]);

function normalizeText(value) {
  return String(value == null ? '' : value).trim();
}

export function resolveSessionWatchUpdateAction(payload) {
  if (!payload || payload.type !== 'update') {
    return {
      reload: false,
      markPending: false,
      clearPending: false
    };
  }

  const eventType = normalizeText(payload.eventType);
  const phase = normalizeText(payload.phase);
  if (STOP_EVENT_TYPES.has(eventType) || STOP_PHASES.has(phase)) {
    return {
      reload: true,
      markPending: false,
      clearPending: true
    };
  }

  return {
    reload: true,
    markPending: !eventType || ACTIVE_EVENT_TYPES.has(eventType),
    clearPending: false
  };
}
