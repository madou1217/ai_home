#!/usr/bin/env node

const SQLITE_EXPERIMENTAL_WARNING_RE = /SQLite is an experimental feature/i;
const originalEmitWarning = process.emitWarning.bind(process);

process.emitWarning = function patchedEmitWarning(warning, ...args) {
  const message = typeof warning === 'string'
    ? warning
    : String((warning && warning.message) || '');
  const type = typeof warning === 'string'
    ? String(args[0] || '')
    : String((warning && warning.name) || args[0] || '');
  if (type === 'ExperimentalWarning' && SQLITE_EXPERIMENTAL_WARNING_RE.test(message)) return;
  return originalEmitWarning(warning, ...args);
};

try {
  const {
    resolveClaudeDesktopGatewayCredential
  } = require('../lib/cli/services/ai-cli/claude-desktop-credential');
  process.stdout.write(`${JSON.stringify(resolveClaudeDesktopGatewayCredential())}\n`);
} catch (error) {
  process.stderr.write(`[aih] Claude Desktop credential helper failed: ${error.message}\n`);
  process.exitCode = 1;
}
