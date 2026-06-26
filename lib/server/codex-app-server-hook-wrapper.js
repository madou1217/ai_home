'use strict';

function shellQuote(value) {
  return `'${String(value || '').replace(/'/g, `'\\''`)}'`;
}

function buildCodexAppServerWrapperScript(marker, options = {}) {
  const {
    nodeExecPath,
    helperScriptPath,
    upstreamBinaryPath,
    stateFilePath
  } = options;
  return [
    '#!/bin/sh',
    `# ${marker}`,
    `UPSTREAM=${shellQuote(upstreamBinaryPath)}`,
    `NODE_BIN=${shellQuote(nodeExecPath)}`,
    `HELPER=${shellQuote(helperScriptPath)}`,
    `STATE_FILE=${shellQuote(stateFilePath)}`,
    'if [ "$1" = "resume" ]; then',
    '  exec "$NODE_BIN" "$HELPER" --run-cli-resume --upstream "$UPSTREAM" --state-file "$STATE_FILE" -- "$@"',
    'fi',
    'if [ "$1" = "app-server" ]; then',
    '  exec "$NODE_BIN" "$HELPER" --upstream "$UPSTREAM" --state-file "$STATE_FILE" -- "$@"',
    'fi',
    'exec "$UPSTREAM" "$@"',
    ''
  ].join('\n');
}

module.exports = {
  buildCodexAppServerWrapperScript,
  shellQuote
};
