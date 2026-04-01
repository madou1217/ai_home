'use strict';

function createUsageCacheService(options = {}) {
  const {
    fs,
    path,
    getProfileDir,
    usageSnapshotSchemaVersion,
    usageSourceGemini,
    usageSourceCodex,
    usageSourceClaudeOauth,
    usageSourceClaudeAuthToken
  } = options;

  const trustedClaudeUsageSources = new Set([
    usageSourceClaudeOauth,
    usageSourceClaudeAuthToken
  ]);

  function getUsageCachePath(cliName, id) {
    return path.join(getProfileDir(cliName, id), '.aih_usage.json');
  }

  function writeUsageCache(cliName, id, payload) {
    try {
      fs.writeFileSync(getUsageCachePath(cliName, id), JSON.stringify(payload, null, 2));
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

    // No trusted usage-remaining source implemented yet for other CLIs.
    return false;
  }

  function readUsageCache(cliName, id) {
    const cachePath = getUsageCachePath(cliName, id);
    if (!fs.existsSync(cachePath)) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
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
