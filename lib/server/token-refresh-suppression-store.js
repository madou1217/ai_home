'use strict';

const nativeFs = require('node:fs');
const nativeOs = require('node:os');
const nativePath = require('node:path');

const { atomicWritePrivateFile } = require('../cli/services/toolkit/proxy-pool/secure-file-io');

const STORE_VERSION = 1;
const STORE_FILE_NAME = 'token-refresh-suppression.json';

// A rejected refresh grant (invalid_grant / revoked / reused) stays rejected
// until the operator logs in again. The token-refresh daemon suppresses repeat
// attempts for INVALID_REFRESH_RETRY_DELAY_MS, but that state used to live only
// in memory, so every server restart re-probed the dead grant and emitted the
// same warning again. Persisting it keeps the promise across restarts.
//
// Only the digest of the refresh token is stored, never the token itself: a new
// login mints a different token, which changes the digest and lifts the
// suppression automatically. Same privacy stance as the in-memory map.
class TokenRefreshSuppressionStore {
  constructor(options = {}) {
    this.fs = options.fs || nativeFs;
    this.path = options.path || nativePath;
    const aiHomeDir = String(
      options.aiHomeDir || process.env.AIH_HOME || this.path.join(nativeOs.homedir(), '.ai_home')
    ).trim();
    this.filePath = options.filePath
      || this.path.join(aiHomeDir, 'run', STORE_FILE_NAME);
  }

  // Returns [{ accountRef, signature, retryAt }]. Never throws: a missing or
  // corrupt store must not be able to break token refresh.
  load() {
    let parsed;
    try {
      parsed = JSON.parse(this.fs.readFileSync(this.filePath, 'utf8'));
    } catch (_error) {
      return [];
    }
    const entries = Array.isArray(parsed && parsed.entries) ? parsed.entries : [];
    const result = [];
    for (const entry of entries) {
      const normalized = normalizeSuppressionEntry(entry);
      if (normalized) result.push(normalized);
    }
    return result;
  }

  // Best-effort: losing the suppression only costs one extra refresh attempt.
  save(entries) {
    const normalized = (Array.isArray(entries) ? entries : [])
      .map(normalizeSuppressionEntry)
      .filter(Boolean);
    try {
      atomicWritePrivateFile(
        this.fs,
        this.path,
        this.filePath,
        `${JSON.stringify({ version: STORE_VERSION, entries: normalized }, null, 2)}\n`
      );
    } catch (_error) {
      /* best effort */
    }
  }
}

function normalizeSuppressionEntry(value) {
  if (!value || typeof value !== 'object') return null;
  const accountRef = String(value.accountRef || '').trim();
  const signature = String(value.signature || '').trim();
  const retryAt = Number(value.retryAt);
  if (!accountRef || !signature) return null;
  if (!Number.isFinite(retryAt) || retryAt <= 0) return null;
  return { accountRef, signature, retryAt: Math.floor(retryAt) };
}

module.exports = {
  TokenRefreshSuppressionStore,
  STORE_FILE_NAME,
  STORE_VERSION
};
