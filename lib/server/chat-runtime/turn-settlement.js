'use strict';

const { sanitizeCanonicalDiagnostic } = require('./canonical-diagnostic-sanitizer');

function terminalResult(run, _result, error) {
  const payload = { state: 'idle' };
  if (run.interruptRequested) {
    return {
      type: 'turn.interrupted',
      outcome: 'failed',
      queueResult: { interrupted: true, reason: 'user_stop' },
      payload: { ...payload, reason: 'user_stop' }
    };
  }
  if (error) return failedResult(payload, error);
  return {
    type: 'turn.completed',
    outcome: 'completed',
    queueResult: {},
    payload
  };
}

function failedResult(payload, error) {
  const serialized = sanitizeCanonicalDiagnostic(error, { fallbackCode: 'chat_turn_failed' });
  return {
    type: 'turn.failed',
    outcome: 'failed',
    queueResult: { error: serialized },
    payload: { ...payload, error: serialized }
  };
}

module.exports = { terminalResult };
