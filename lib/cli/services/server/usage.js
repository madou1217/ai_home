'use strict';

function renderServerUsageText() {
  return `
\x1b[36mAI Home Server Helpers\x1b[0m

\x1b[33mUsage:\x1b[0m
  aih serve
  aih server
  aih server start
  aih server restart
  aih server stop
  aih server status
  aih server autostart <install|uninstall|status>
  aih server serve
  aih server serve [--port <n>]

\x1b[33mNotes:\x1b[0m
  - Default listen: http://127.0.0.1:8317
  - OpenAI-compatible endpoint: http://127.0.0.1:8317/v1
  - Server runs provider-specific adapters (codex/gemini/claude) with dedicated base URLs.
  - Default provider mode is auto (routes by model hint: gpt/o* -> codex, gemini* -> gemini, claude* -> claude).
  - Default strategy is random (weighted by account remaining usage).
  - No extra key setup is required in default mode.
  - aih serve is equivalent to aih server start (daemon mode).

\x1b[33mAdvanced (optional):\x1b[0m
  aih server serve [--host <ip>] [--port <n>] [--backend codex-adapter] [--provider codex|gemini|claude|auto] [--codex-base-url <url>] [--gemini-base-url <url>] [--claude-base-url <url>] [--codex-models <csv>] [--proxy-url <url>] [--no-proxy <hosts>] [--strategy round-robin|random] [--codex-max-concurrency <n>] [--gemini-max-concurrency <n>] [--claude-max-concurrency <n>] [--queue-limit <n>] [--session-affinity-ttl-ms <ms>] [--session-affinity-max <n>] [--client-key <key>] [--management-key <key>] [--cooldown-ms <ms>] [--max-attempts <n>] [--upstream-timeout-ms <ms>]
  aih server env [--base-url <url>] [--api-key <key>]
  aih server sync-codex [--management-url <url>] [--key <management-key>] [--parallel <1-32>] [--limit <n>] [--dry-run]
  management APIs: /v0/management/status, /v0/management/metrics, /v0/management/accounts, /v0/management/models, /v0/management/reload
`;
}

function showServerUsage(log = console.log) {
  log(renderServerUsageText());
}

module.exports = {
  renderServerUsageText,
  showServerUsage
};
