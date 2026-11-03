'use strict';

const CODEX_APP_SERVER_PASSTHROUGH_ENV = 'AIH_CODEX_APP_SERVER_PASSTHROUGH';
const CODEX_GLOBAL_VALUE_OPTIONS = Object.freeze([
  '-c', '--config', '--enable', '--disable', '--remote', '--remote-auth-token-env',
  '-i', '--image', '-m', '--model', '--local-provider', '-p', '--profile',
  '-s', '--sandbox', '-C', '--cd', '--add-dir', '-a', '--ask-for-approval'
]);
const CODEX_GLOBAL_VALUE_OPTION_SET = new Set(CODEX_GLOBAL_VALUE_OPTIONS);

function shellQuote(value) {
  return `'${String(value || '').replace(/'/g, `'\\''`)}'`;
}

function buildCodexAppServerWrapperScript(marker, options = {}) {
  const {
    nodeExecPath,
    helperScriptPath,
    upstreamBinaryPath,
    stateFilePath,
    routeDefaultCliThroughHelper = false
  } = options;
  return [
    '#!/bin/sh',
    `# ${marker}`,
    `UPSTREAM=${shellQuote(upstreamBinaryPath)}`,
    `NODE_BIN=${shellQuote(nodeExecPath)}`,
    `HELPER=${shellQuote(helperScriptPath)}`,
    `STATE_FILE=${shellQuote(stateFilePath)}`,
    'AIH_SUBCOMMAND=',
    'AIH_EXPECT_OPTION_VALUE=0',
    'for AIH_ARG in "$@"; do',
    '  if [ "$AIH_EXPECT_OPTION_VALUE" = "1" ]; then',
    '    AIH_EXPECT_OPTION_VALUE=0',
    '    continue',
    '  fi',
    '  case "$AIH_ARG" in',
    `    ${CODEX_GLOBAL_VALUE_OPTIONS.join('|')})`,
    '      AIH_EXPECT_OPTION_VALUE=1',
    '      ;;',
    '    --)',
    '      break',
    '      ;;',
    '    --*=*|-*)',
    '      ;;',
    '    *)',
    '      AIH_SUBCOMMAND="$AIH_ARG"',
    '      break',
    '      ;;',
    '  esac',
    'done',
    'if [ "$AIH_SUBCOMMAND" = "resume" ]; then',
    '  exec "$NODE_BIN" "$HELPER" --run-cli-resume --upstream "$UPSTREAM" --state-file "$STATE_FILE" -- "$@"',
    'fi',
    `if [ "$AIH_SUBCOMMAND" = "app-server" ] && [ "\${${CODEX_APP_SERVER_PASSTHROUGH_ENV}:-}" = "1" ]; then`,
    `  unset ${CODEX_APP_SERVER_PASSTHROUGH_ENV}`,
    '  exec "$UPSTREAM" "$@"',
    'fi',
    'if [ "$AIH_SUBCOMMAND" = "app-server" ]; then',
    '  exec "$NODE_BIN" "$HELPER" --upstream "$UPSTREAM" --state-file "$STATE_FILE" -- "$@"',
    'fi',
    routeDefaultCliThroughHelper
      ? 'exec "$NODE_BIN" "$HELPER" --run-cli-default --upstream "$UPSTREAM" --state-file "$STATE_FILE" -- "$@"'
      : 'exec "$UPSTREAM" "$@"',
    ''
  ].join('\n');
}

function findCodexSubcommand(args = []) {
  let expectOptionValue = false;
  for (const value of Array.isArray(args) ? args : []) {
    const argument = String(value || '');
    if (expectOptionValue) {
      expectOptionValue = false;
      continue;
    }
    if (argument === '--') return '';
    if (CODEX_GLOBAL_VALUE_OPTION_SET.has(argument)) {
      expectOptionValue = true;
      continue;
    }
    if (argument.startsWith('-')) continue;
    return argument;
  }
  return '';
}

module.exports = {
  CODEX_APP_SERVER_PASSTHROUGH_ENV,
  CODEX_GLOBAL_VALUE_OPTIONS,
  buildCodexAppServerWrapperScript,
  findCodexSubcommand,
  shellQuote
};
