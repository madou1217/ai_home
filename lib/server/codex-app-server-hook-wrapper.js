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
    'AIH_SUBCOMMAND=',
    'AIH_EXPECT_OPTION_VALUE=0',
    'for AIH_ARG in "$@"; do',
    '  if [ "$AIH_EXPECT_OPTION_VALUE" = "1" ]; then',
    '    AIH_EXPECT_OPTION_VALUE=0',
    '    continue',
    '  fi',
    '  case "$AIH_ARG" in',
    '    -c|--config|--enable|--disable|--remote|--remote-auth-token-env|-i|--image|-m|--model|--local-provider|-p|--profile|-s|--sandbox|-C|--cd|--add-dir|-a|--ask-for-approval)',
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
    'if [ "$AIH_SUBCOMMAND" = "app-server" ]; then',
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
