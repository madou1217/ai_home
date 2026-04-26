#!/usr/bin/env node

const SQLITE_EXPERIMENTAL_WARNING_RE = /SQLite is an experimental feature/i;
const originalEmitWarning = process.emitWarning.bind(process);

process.emitWarning = function patchedEmitWarning(warning, ...args) {
  const warningMessage = typeof warning === 'string'
    ? warning
    : String((warning && warning.message) || '');
  const warningType = typeof warning === 'string'
    ? String(args[0] || '')
    : String((warning && warning.name) || args[0] || '');

  if (warningType === 'ExperimentalWarning' && SQLITE_EXPERIMENTAL_WARNING_RE.test(warningMessage)) {
    return;
  }

  return originalEmitWarning(warning, ...args);
};

require('../lib/cli/app');
