'use strict';

/**
 * Turn an unknown failure value into useful text at a protocol boundary.
 * Avoids the lossy `[object Object]` conversion when a nested error payload
 * reaches a CLI, native helper, or streamed UI.
 */
function formatDiagnosticMessage(value, fallback = '') {
  if (value === undefined || value === null) return String(fallback || '');
  if (value instanceof Error && value.message) return String(value.message);
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') {
    return String(value);
  }
  if (typeof value === 'object') {
    for (const key of ['message', 'detail', 'error', 'reason']) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      const nested = formatDiagnosticMessage(value[key], '');
      if (nested) return nested;
    }
    try {
      const encoded = JSON.stringify(value);
      if (encoded && encoded !== '{}') return encoded;
    } catch (_error) {
      return Object.prototype.toString.call(value);
    }
  }
  return String(fallback || '');
}

module.exports = { formatDiagnosticMessage };
