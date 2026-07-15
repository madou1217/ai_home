'use strict';

const { getAppStateDbPath } = require('../../../server/app-state-store');
const {
  readAccountUsageSnapshot,
  writeAccountUsageSnapshot
} = require('../../../account/usage-snapshot-store');
const { isAccountRef } = require('../../../server/account-ref-store');

function createUsageCacheService(options = {}) {
  const {
    fs,
    aiHomeDir,
    usageSnapshotSchemaVersion,
    usageSourceGemini,
    usageSourceCodex,
    usageSourceClaudeOauth,
    usageSourceClaudeAuthToken,
    usageSourceAgyCodeAssist
  } = options;

  const trustedClaudeUsageSources = new Set([
    usageSourceClaudeOauth,
    usageSourceClaudeAuthToken
  ]);

  function getUsageCachePath(_cliName, accountRef) {
    return isAccountRef(accountRef) ? getAppStateDbPath(aiHomeDir) : '';
  }

  function writeUsageCache(_cliName, accountRef, payload) {
    try {
      writeAccountUsageSnapshot(fs, aiHomeDir, accountRef, payload);
    } catch (_error) {
      // best effort cache
    }
  }

  function isTrustedUsageSnapshot(cliName, snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return false;
    if (snapshot.schemaVersion !== usageSnapshotSchemaVersion) return false;
    if (!snapshot.capturedAt || !Number.isFinite(Number(snapshot.capturedAt))) return false;

    if (cliName === 'gemini') {
      return snapshot.kind === 'gemini_oauth_stats' && snapshot.source === usageSourceGemini;
    }
    if (cliName === 'codex') {
      return snapshot.kind === 'codex_oauth_status' && snapshot.source === usageSourceCodex;
    }
    if (cliName === 'claude') {
      return snapshot.kind === 'claude_oauth_usage' && trustedClaudeUsageSources.has(snapshot.source);
    }
    if (cliName === 'agy') {
      return snapshot.kind === 'agy_code_assist_quota'
        && snapshot.source === (usageSourceAgyCodeAssist || 'agy_fetch_available_models')
        && Array.isArray(snapshot.models);
    }

    // No trusted usage-remaining source implemented yet for other CLIs.
    return false;
  }

  function readUsageCache(cliName, accountRef) {
    try {
      const parsed = readAccountUsageSnapshot(fs, aiHomeDir, accountRef);
      if (!isTrustedUsageSnapshot(cliName, parsed)) return null;
      return parsed;
    } catch (_error) {
      return null;
    }
  }

  return {
    getUsageCachePath,
    writeUsageCache,
    readUsageCache,
    isTrustedUsageSnapshot
  };
}

module.exports = {
  createUsageCacheService
};
