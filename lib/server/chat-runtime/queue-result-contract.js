'use strict';

const { sanitizeCanonicalDiagnostic } = require('./canonical-diagnostic-sanitizer');

function projectCanonicalQueueResult(status, input) {
  if (status === 'completed') return {};
  if (status !== 'failed') return undefined;
  const result = record(input) || {};
  const error = record(result.error) || result;
  return { error: sanitizeCanonicalDiagnostic(error, { fallbackCode: 'chat_queue_failed' }) };
}

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

module.exports = { projectCanonicalQueueResult };
