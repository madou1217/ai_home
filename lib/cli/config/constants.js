'use strict';

// Snapshot freshness, scheduler windows, and schema/source ids for usage tracking.
const USAGE_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const USAGE_REFRESH_STALE_MS = 5 * 60 * 1000;
const USAGE_INDEX_STALE_REFRESH_MS = 3 * 60 * 1000;
const USAGE_INDEX_BG_REFRESH_LIMIT = 400;
const USAGE_SNAPSHOT_SCHEMA_VERSION = 2;
const USAGE_SOURCE_GEMINI = 'gemini_refresh_user_quota';
const USAGE_SOURCE_CODEX = 'codex_app_server';
const USAGE_SOURCE_CLAUDE_OAUTH = 'claude_oauth_usage_api';
const USAGE_SOURCE_CLAUDE_AUTH_TOKEN = 'claude_auth_token_usage_api';
const USAGE_SOURCE_AGY_CODE_ASSIST = 'agy_fetch_available_models';
const { USAGE_SOURCE_KIMI } = require('../../account/usage-remaining');

// Generic CLI output and backup envelope constants.
const LIST_PAGE_SIZE = 10;
const EXPORT_MAGIC = 'AIH_EXPORT_V2:';
const EXPORT_VERSION = 2;
const AGE_SSH_KEY_TYPES = new Set(['ssh-ed25519', 'ssh-rsa']);

// Claude launch --settings files (0600, hold gateway credentials): files not rewritten by any
// launch for this long are pruned on the next write, so rotated keys do not linger on disk.
// Long enough that a running Claude session never loses the file it was started with.
const CLAUDE_LAUNCH_SETTINGS_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

// Egress pool node ledger (lib/runtime/egress-pool-node-health.js): per-node cooldowns after an
// exit-bound failure, the recovery probe cadence, and how much history is kept.
//   - FREE_LIMIT: 429 FreeUsageLimitError is counted per (exit IP x model); upstream resets it in
//     minutes to hours, so a limited exit is skipped for a while instead of being re-hit.
//   - GATE: the free-tier gate flips per exit within minutes (measured 2026-10-18).
//   - NETWORK: unreachable node; doubles per consecutive failure up to the cap, and a successful
//     recovery probe clears it early.
//   - IP_BLOCKED: 403 FreeTierError "detected abusive traffic from this IP address" — the exit IP
//     is blacklisted upstream; it does not flip within minutes and a reachability probe cannot
//     prove it lifted, so the node is skipped for hours (manual clear in the WebUI still works).
const EGRESS_POOL_NODE_FREE_LIMIT_COOLDOWN_MS = 15 * 60 * 1000;
const EGRESS_POOL_NODE_GATE_COOLDOWN_MS = 2 * 60 * 1000;
const EGRESS_POOL_NODE_NETWORK_COOLDOWN_MS = 60 * 1000;
const EGRESS_POOL_NODE_IP_BLOCKED_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const EGRESS_POOL_NODE_MAX_COOLDOWN_MS = 30 * 60 * 1000;
const EGRESS_POOL_PROBE_INTERVAL_MS = 60 * 1000;
const EGRESS_POOL_PROBE_TIMEOUT_MS = 5000;
const EGRESS_POOL_EVENT_HISTORY = 200;

// Daemon identity for platform autostart integrations.
const AIH_SERVER_LAUNCHD_LABEL = 'com.clawdcodex.ai_home';

module.exports = {
  USAGE_CACHE_MAX_AGE_MS,
  USAGE_REFRESH_STALE_MS,
  USAGE_INDEX_STALE_REFRESH_MS,
  USAGE_INDEX_BG_REFRESH_LIMIT,
  USAGE_SNAPSHOT_SCHEMA_VERSION,
  USAGE_SOURCE_GEMINI,
  USAGE_SOURCE_CODEX,
  USAGE_SOURCE_CLAUDE_OAUTH,
  USAGE_SOURCE_CLAUDE_AUTH_TOKEN,
  USAGE_SOURCE_AGY_CODE_ASSIST,
  USAGE_SOURCE_KIMI,
  LIST_PAGE_SIZE,
  EXPORT_MAGIC,
  EXPORT_VERSION,
  AGE_SSH_KEY_TYPES,
  CLAUDE_LAUNCH_SETTINGS_RETENTION_MS,
  EGRESS_POOL_NODE_FREE_LIMIT_COOLDOWN_MS,
  EGRESS_POOL_NODE_GATE_COOLDOWN_MS,
  EGRESS_POOL_NODE_NETWORK_COOLDOWN_MS,
  EGRESS_POOL_NODE_IP_BLOCKED_COOLDOWN_MS,
  EGRESS_POOL_NODE_MAX_COOLDOWN_MS,
  EGRESS_POOL_PROBE_INTERVAL_MS,
  EGRESS_POOL_PROBE_TIMEOUT_MS,
  EGRESS_POOL_EVENT_HISTORY,
  AIH_SERVER_LAUNCHD_LABEL
};
