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

// Generic CLI output and backup envelope constants.
const LIST_PAGE_SIZE = 10;
const EXPORT_MAGIC = 'AIH_EXPORT_V2:';
const EXPORT_VERSION = 2;
const AGE_SSH_KEY_TYPES = new Set(['ssh-ed25519', 'ssh-rsa']);

// Daemon identity for macOS launchd integration.
const AIH_SERVER_LAUNCHD_LABEL = 'com.aih.server';

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
  LIST_PAGE_SIZE,
  EXPORT_MAGIC,
  EXPORT_VERSION,
  AGE_SSH_KEY_TYPES,
  AIH_SERVER_LAUNCHD_LABEL
};
