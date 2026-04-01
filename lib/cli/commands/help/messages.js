'use strict';

function createCliHelpService(options = {}) {
  const {
    log = console.log
  } = options;

  function showHelp() {
    log(`
\x1b[36mAI Home (aih)\x1b[0m - Multi-account sandbox manager for AI CLIs

\x1b[33mUsage:\x1b[0m
  aih ls                    \x1b[90mList all tools, accounts, and their status\x1b[0m
  aih count                 \x1b[90mShow account counts for all tools\x1b[0m
  aih ls --help             \x1b[90mShow list mode help (paging behavior)\x1b[0m
  aih <cli> ls              \x1b[90mList accounts for a specific tool\x1b[0m
  aih <cli> ls --help       \x1b[90mShow list mode help for this tool\x1b[0m
  aih <cli> login [--no-browser]  \x1b[90mCreate a new account and run login flow (device/server-friendly)\x1b[0m
  aih <cli>                 \x1b[90mRun a tool with the default account (ID: 1)\x1b[0m
  aih <cli> auto            \x1b[90mRun the next non-exhausted account automatically\x1b[0m
  aih <cli> delete <ids>    \x1b[90mDelete one or more accounts (e.g. 1,2,3 or 1-9)\x1b[0m
  aih <cli> deleteall       \x1b[90mDelete all accounts for a tool\x1b[0m
  aih <cli> usage [id] [--no-cache] [-j N] \x1b[90mQuery one account by id, or scan all accounts (when id omitted)\x1b[0m
  aih dev mock-usage <provider> <id> [--remaining <pct>] [--duration-sec <sec>] \x1b[90mTemporarily mock usage snapshot for threshold switch testing\x1b[0m
  aih <cli> import [sources...] [-j N] [--dry-run]\x1b[90mImport this provider from dirs, zip, nested zip folders, or cliproxyapi\x1b[0m
  aih <cli> <id> usage      \x1b[90mSame as above, ID-first style\x1b[0m
  aih <cli> unlock <id>     \x1b[90mManually clear [Exhausted Limit] for an account\x1b[0m
  aih <cli> <id> unlock     \x1b[90mSame as above, ID-first style\x1b[0m
  aih <cli> <id> [args]     \x1b[90mRun a tool with a specific account ID\x1b[0m
  aih serve                 \x1b[90mStart local OpenAI-compatible server (daemon mode)\x1b[0m
  aih server [action]       \x1b[90mManage local OpenAI-compatible server\x1b[0m
  
\x1b[33mAdvanced:\x1b[0m
  aih <cli> set-default <id>\x1b[90mSet default account for aih only\x1b[0m
  aih export [file.zip] [selectors...] \x1b[90mExport credential-only zip in accounts/<provider>/<id> layout\x1b[0m
  aih export cliproxyapi codex      \x1b[90mExport codex OAuth auth.json files into local CLIProxyAPI auth-dir\x1b[0m
  aih import [provider] [sources...] [-j N] [-f <folder>] [--dry-run]\x1b[90mImport mixed dirs/zip/cliproxyapi sources; folders auto-discover nested zips and provider dirs\x1b[0m
`);
  }

  function showCliUsage(cliName) {
    log(`
\x1b[36mAI Home (aih)\x1b[0m - Subcommands for \x1b[33m${cliName}\x1b[0m

\x1b[33mUsage:\x1b[0m
  aih ${cliName} ls              \x1b[90mList all ${cliName} accounts\x1b[0m
  aih ${cliName} count           \x1b[90mShow account count for ${cliName}\x1b[0m
  aih ${cliName} ls --help       \x1b[90mShow list mode help (paging behavior)\x1b[0m
  aih ${cliName} login [--no-browser] \x1b[90mCreate a new account and login (no browser mode supported)\x1b[0m
  aih ${cliName} auto            \x1b[90mAuto-select next non-exhausted account\x1b[0m
  aih ${cliName} delete <ids>    \x1b[90mDelete one or more accounts (e.g. 1,2,3 or 1-9)\x1b[0m
  aih ${cliName} deleteall       \x1b[90mDelete all ${cliName} accounts\x1b[0m
  aih ${cliName} usage [id] [--no-cache] [-j N] \x1b[90mQuery one account by id, or scan all accounts with concurrency N\x1b[0m
  ${cliName === 'codex' ? 'aih codex policy [set <workspace-write|read-only|danger-full-access>]  \x1b[90mShow or update exec sandbox policy\x1b[0m' : ''}
  aih ${cliName} import [sources...] [-j N] [--dry-run]  \x1b[90mImport this provider from dirs, zip, nested zip folders, or cliproxyapi\x1b[0m
  aih ${cliName} unlock <id>     \x1b[90mClear exhausted flag manually\x1b[0m
  aih ${cliName} <id> usage      \x1b[90mID-first style usage query\x1b[0m
  aih ${cliName} <id> unlock     \x1b[90mID-first style manual unlock\x1b[0m
  aih ${cliName} <id> [args]     \x1b[90mRun ${cliName} under a specific account\x1b[0m
  aih ${cliName}                 \x1b[90mRun with default account\x1b[0m
`);
  }

  return {
    showHelp,
    showCliUsage
  };
}

module.exports = {
  createCliHelpService
};
