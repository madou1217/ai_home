'use strict';

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 2000;

function normalizeText(value) {
  return String(value == null ? '' : value).trim();
}

function normalizeSession(session = {}) {
  return {
    provider: normalizeText(session.provider).toLowerCase(),
    sessionId: normalizeText(session.sessionId || session.session_id),
    projectDirName: normalizeText(session.projectDirName || session.project_dir_name),
    projectPath: normalizeText(session.projectPath || session.project_path)
  };
}

function createProviderSessionCorrelationRegistry(options = {}) {
  const ttlMs = Math.max(1000, Number(options.ttlMs) || DEFAULT_TTL_MS);
  const maxEntries = Math.max(1, Number(options.maxEntries) || DEFAULT_MAX_ENTRIES);
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const entries = new Map();

  function prune() {
    const cutoff = now() - ttlMs;
    for (const [key, entry] of entries) {
      if (entry.updatedAt >= cutoff && entries.size <= maxEntries) break;
      entries.delete(key);
    }
  }

  function bind(correlationId, session) {
    const key = normalizeText(correlationId);
    const normalized = normalizeSession(session);
    if (!key || key.length > 128 || !normalized.provider || !normalized.sessionId) return false;
    entries.delete(key);
    entries.set(key, { session: normalized, updatedAt: now() });
    prune();
    return true;
  }

  function resolve(correlationId) {
    const key = normalizeText(correlationId);
    if (!key || key.length > 128) return null;
    const entry = entries.get(key);
    if (!entry) return null;
    if (now() - entry.updatedAt > ttlMs) {
      entries.delete(key);
      return null;
    }
    return { ...entry.session };
  }

  return { bind, resolve };
}

module.exports = {
  createProviderSessionCorrelationRegistry
};
