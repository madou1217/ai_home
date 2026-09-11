'use strict';

const { sanitizeCanonicalDiagnostic } = require('./canonical-diagnostic-sanitizer');

function terminalResult(run, result, error) {
  const payload = { state: 'idle' };
  if (error?.outcomeUnknown === true) {
    return failedResult({ ...payload, retryable: false, outcomeUnknown: true }, error);
  }
  if (run.interruptRequested || result?.status === 'interrupted') {
    return {
      type: 'turn.interrupted',
      outcome: 'failed',
      queueResult: { interrupted: true, reason: 'user_stop' },
      payload: { ...payload, reason: 'user_stop' }
    };
  }
  if (error) return failedResult({ ...payload, retryable: Boolean(run.submissionCommandId) }, error);
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
