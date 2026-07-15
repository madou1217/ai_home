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
  aih ls --help             \x1b[90mShow list mode help (paging behavior)\x1b[0m
  aih sessions | ss         \x1b[90mSelect and enter an active persistent session\x1b[0m
  aih ss --list             \x1b[90mPreview active sessions grouped by project\x1b[0m
  aih update [--check] [--dry-run] [--force] \x1b[90mCheck for updates or update ai-home via npm\x1b[0m
  aih <cli> ls              \x1b[90mList accounts for a specific tool\x1b[0m
  aih <cli> ls --help       \x1b[90mShow list mode help for this tool\x1b[0m
  aih <cli> login [--no-browser]  \x1b[90mCreate a new account and run login flow (device/server-friendly)\x1b[0m
  aih codex|claude [args...] \x1b[90mRun through the built-in AIH server profile and forward native CLI args\x1b[0m
  aih gemini                \x1b[90mRun gemini with the default account (ID: 1)\x1b[0m
  aih <cli> delete <ids>    \x1b[90mDelete one or more accounts (e.g. 1,2,3 or 1-9)\x1b[0m
  aih <cli> deleteall       \x1b[90mDelete all accounts for a tool\x1b[0m
  aih usage [stats|models|sessions|scan] [--from YYYY-MM-DD] [--to YYYY-MM-DD] \x1b[90mModel token/cost accounting by provider/model\x1b[0m
  aih ssh [ssh args...] -- aih <cli> [args...] \x1b[90mNon-zero-client SSH image-paste wrapper fallback\x1b[0m
  aih ssh-clipboard probe \x1b[90mProbe strict zero-client terminal image clipboard support\x1b[0m
  aih clip-agent start      \x1b[90mNon-zero-client clipboard image provider for SSH RemoteForward fallback\x1b[0m
  aih server add <name> --url <url> --management-key <key> \x1b[90mSave and select a remote Server\x1b[0m
  aih server ls            \x1b[90mList saved Servers without printing Management Keys\x1b[0m
  aih node bootstrap [--target linux|darwin|win32] \x1b[90mGenerate a low-touch remote node bootstrap plan/script\x1b[0m
  aih node bootstrap probe [--ssh user@host] [--tcp host] [--http URL] \x1b[90mReadonly bootstrap and HTTP ingress probe for remote machines\x1b[0m
  aih node bootstrap apply [probe options...] [--asset-mode local] [--execute --yes] \x1b[90mDry-run or execute SSH-ready remote bootstrap actions\x1b[0m
  aih node service status [--control-url URL] --node-id ID \x1b[90mShow supervised node readiness across relay, registry agent, and WebRTC services\x1b[0m
  aih node service install <server-url> --node-id ID [--management-key-file FILE] --dry-run \x1b[90mImport the Management Key once, then plan supervised autostart\x1b[0m
  aih node service uninstall --node-id ID --dry-run \x1b[90mPlan supervised relay + registry agent + WebRTC autostart rollback\x1b[0m
  aih node relay connect <control-url> --node-id ID \x1b[90mKeep this node connected through outbound relay\x1b[0m
  aih node relay service install <control-url> --node-id ID \x1b[90mInstall relay connect as a login service\x1b[0m
  aih node webrtc service install <control-url> --node-id ID \x1b[90mInstall WebRTC connector as a login service\x1b[0m
  aih fabric transport probe <endpoint...> \x1b[90mReadonly Fabric TCP/HTTP transport evidence probe\x1b[0m
  aih fabric transport tcp-echo <tcp-url> \x1b[90mRaw TCP application-data echo benchmark\x1b[0m
  aih <cli> usage [id] [--refresh] [-j N] \x1b[90mQuery one account by id, or scan all accounts (when id omitted)\x1b[0m
  aih <cli> home [id]      \x1b[90mShow effective HOME/config paths without launching the native CLI\x1b[0m
  aih <cli> terminal-icon  \x1b[90mShow/install real provider icons for terminal profiles\x1b[0m
  aih <cli> import [sources...] [-j N] [--dry-run]\x1b[90mImport this provider from dirs, zip, nested zip folders, or cliproxyapi\x1b[0m
  aih <cli> <id> usage      \x1b[90mSame as above, ID-first style\x1b[0m
  aih <cli> <id> home       \x1b[90mSame home/config diagnostics, ID-first style\x1b[0m
  aih <cli> <id> [args]     \x1b[90mRun a tool with a specific account ID\x1b[0m
  aih serve                 \x1b[90mStart local OpenAI-compatible server (daemon mode)\x1b[0m
  aih server [action]       \x1b[90mManage local OpenAI-compatible server\x1b[0m
  aih daemon [action]       \x1b[90mAlias for aih server daemon lifecycle/autostart\x1b[0m

\x1b[33mRemote Notes:\x1b[0m
  relay is the default no-public-IP path; provider/route/trust are derived from transport
  Fabric starts with explicit server profiles; use aih fabric transport probe and tcp-echo to collect endpoint evidence
  Web, desktop, CLI, phones, and other computers connect with Server URL + Management Key
  --asset-mode local transfers source + Node.js runtime archive from this machine for weak/no-public-network nodes
  FRP/SSH/VPN/OMR/MPTCP require a user-managed HTTP endpoint before carrying AIH RPC

\x1b[33mAdvanced:\x1b[0m
  aih <cli> set-default <id> [--restart-client] [--force-quit-client]\x1b[90mSet default account; optionally restart/launch learned desktop client\x1b[0m
  aih <cli> unset-default    \x1b[90mClear the default account pointer for this tool\x1b[0m
  aih codex set-mobile <id>       \x1b[90mSet Codex App account (ChatGPT OAuth only)\x1b[0m
  aih codex unset-mobile          \x1b[90mClear the Codex App account pointer\x1b[0m
  aih export [file.zip] [selectors...] \x1b[90mExport flat account JSON files named provider_email/provider_url_ref\x1b[0m
  aih export cliproxyapi [all|codex|gemini|claude] [file.json] \x1b[90mExport CLIProxyAPI-compatible account data JSON\x1b[0m
  aih export sub2api [provider] [file.json] \x1b[90mExport accounts as sub2api-data JSON\x1b[0m
  aih export antigravity [file.json] \x1b[90mExport AGY OAuth accounts as Antigravity-Manager JSON\x1b[0m
  aih import [provider] [sources...] [-j N] [-f <folder>] [--dry-run]\x1b[90mImport mixed dirs/zip/json/cliproxyapi sources; folders auto-discover zips, JSON, and provider dirs\x1b[0m

\x1b[33mSSH Image Paste:\x1b[0m
  Strict zero-client means no client helper/config: normal SSH to the host, run aih <cli> <id>, then paste or press Alt+V
  This requires the local terminal to support OSC 5522 image clipboard read / 5522 paste events, or OSC 52 reads that return image/data-url data; aih enables tmux passthrough where it controls tmux
  Diagnose ambient reads with: aih ssh-clipboard probe --json
  Diagnose the real paste path with: aih ssh-clipboard probe --paste-event --json --timeout-ms 10000
  If the terminal cannot return image data, strict zero-client cannot fetch the client's clipboard image
  Non-zero-client fallback is explicit opt-in: AIH_SSH_CLIP_AGENT=1 with aih clip-agent start and RemoteForward /tmp/aih-clip-%r.sock 127.0.0.1:17652
  aih ssh user@host -- aih claude remains a separate non-zero-client wrapper fallback
`);
  }

  function showCliUsage(cliName) {
    log(`
\x1b[36mAI Home (aih)\x1b[0m - Subcommands for \x1b[33m${cliName}\x1b[0m

\x1b[33mUsage:\x1b[0m
  aih ${cliName} ls              \x1b[90mList all ${cliName} accounts\x1b[0m
  aih ${cliName} ls --help       \x1b[90mShow list mode help (paging behavior)\x1b[0m
  aih ${cliName} login [--no-browser] \x1b[90mCreate a new account and login (no browser mode supported)\x1b[0m
  aih ${cliName} delete <ids>    \x1b[90mDelete one or more accounts (e.g. 1,2,3 or 1-9)\x1b[0m
  aih ${cliName} deleteall       \x1b[90mDelete all ${cliName} accounts\x1b[0m
  aih ${cliName} usage <id> [--refresh] [--preflight] \x1b[90mQuery one account by id\x1b[0m
  aih ${cliName} usage [--refresh] [--preflight] [-j N] \x1b[90mScan all accounts; --refresh forces re-probe, -j caps workers\x1b[0m
  aih ${cliName} home [id]       \x1b[90mShow effective HOME/config paths without launching the native CLI\x1b[0m
  aih ${cliName} terminal-icon [--install] [--all] \x1b[90mInstall provider icons/mappings for the current terminal\x1b[0m
  aih ${cliName} set-default <id> [--restart-client] [--force-quit-client] \x1b[90mSet default account; optionally restart/launch learned desktop client\x1b[0m
  aih ${cliName} unset-default     \x1b[90mClear the default account pointer\x1b[0m
  ${cliName === 'codex' ? 'aih codex set-mobile <id>       \x1b[90mSet Codex App account (ChatGPT OAuth only)\x1b[0m' : ''}
  ${cliName === 'codex' ? 'aih codex unset-mobile          \x1b[90mClear the Codex App account pointer\x1b[0m' : ''}
  ${cliName === 'codex' ? 'aih codex policy [set <workspace-write|read-only|danger-full-access>]  \x1b[90mShow or update exec sandbox policy\x1b[0m' : ''}
  aih ${cliName} import [sources...] [-j N] [--dry-run]  \x1b[90mImport this provider from dirs, zip, nested zip folders, or cliproxyapi\x1b[0m
  aih ${cliName} <id> usage      \x1b[90mID-first style usage query\x1b[0m
  aih ${cliName} <id> home       \x1b[90mID-first style home/config diagnostics\x1b[0m
  aih ${cliName} <id> [args]     \x1b[90mRun ${cliName} under a specific account\x1b[0m
  aih ${cliName}${cliName === 'codex' || cliName === 'claude' ? ' [args...]' : ''}                 \x1b[90m${cliName === 'codex' || cliName === 'claude' ? 'Run through the built-in AIH server profile and forward native CLI args' : 'Run with default account'}\x1b[0m
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
