'use strict';

const path = require('path');
const crypto = require('crypto');
const {
  SUPPORTED_SERVER_PROVIDERS,
  inferProviderFromModel,
  isSupportedProvider
} = require('./providers');
const { APP_STATE_DB_FILE } = require('./app-state-store');

const ALIASES_DB_FILE = APP_STATE_DB_FILE;
const ALIAS_SCOPE_PROVIDERS = Object.freeze(['all', ...SUPPORTED_SERVER_PROVIDERS]);
const ALIAS_TARGET_PROVIDER_AUTO = 'auto';
const ALIAS_TARGET_PROVIDERS = Object.freeze([ALIAS_TARGET_PROVIDER_AUTO, ...SUPPORTED_SERVER_PROVIDERS]);
const DEFAULT_BUSY_TIMEOUT_MS = 5000;

function generateAliasId() {
  return crypto.randomBytes(4).toString('hex');
}

function normalizeAliasScopeProvider(value) {
  const provider = String(value || '').trim().toLowerCase();
  return ALIAS_SCOPE_PROVIDERS.includes(provider) ? provider : 'all';
}

function normalizeAliasTargetProvider(value) {
  const provider = String(value || '').trim().toLowerCase();
  if (!provider) return ALIAS_TARGET_PROVIDER_AUTO;
  return ALIAS_TARGET_PROVIDERS.includes(provider) ? provider : ALIAS_TARGET_PROVIDER_AUTO;
}

function normalizeRequestProvider(value) {
  const provider = String(value || '').trim().toLowerCase();
  return isSupportedProvider(provider) ? provider : '';
}

function normalizeAliasPriority(value) {
  const priority = Number(value);
  return Number.isFinite(priority) ? Math.trunc(priority) : 0;
}

function normalizeAliasRecord(value, fallback = {}) {
  const source = {
    ...(fallback || {}),
    ...(value || {})
  };
  return {
    id: String(source.id || '').trim(),
    alias: String(source.alias || '').trim(),
    target: String(source.target || '').trim(),
    provider: normalizeAliasScopeProvider(source.provider),
    targetProvider: normalizeAliasTargetProvider(source.targetProvider),
    priority: normalizeAliasPriority(source.priority),
    enabled: source.enabled !== false,
    description: String(source.description || '').trim()
  };
}

function normalizeAliasData(data) {
  const aliases = Array.isArray(data && data.aliases)
    ? data.aliases.map((item) => normalizeAliasRecord(item)).filter((item) => item.alias && item.target)
    : [];
  return { aliases };
}

function getModelAliasDbPath(aiHomeDir) {
  return path.join(aiHomeDir, ALIASES_DB_FILE);
}

function getDatabaseSyncCtor(deps = {}) {
  if (Object.prototype.hasOwnProperty.call(deps, 'DatabaseSync')) {
    return deps.DatabaseSync;
  }
  try {
    return require('node:sqlite').DatabaseSync;
  } catch (_error) {
    return null;
  }
}

function canUseAliasDatabase(fs, aiHomeDir, deps = {}) {
  if (!aiHomeDir || !fs || typeof fs.mkdirSync !== 'function') return false;
  return typeof getDatabaseSyncCtor(deps) === 'function';
}

function ensureAliasSchema(db) {
  db.exec(`PRAGMA busy_timeout = ${DEFAULT_BUSY_TIMEOUT_MS};`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS model_aliases (
      id TEXT PRIMARY KEY,
      alias TEXT NOT NULL,
      target TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'all',
      target_provider TEXT NOT NULL DEFAULT 'auto',
      priority INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      description TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_model_aliases_enabled_provider ON model_aliases(enabled, provider)');
}

function openAliasDatabase(fs, aiHomeDir, deps = {}) {
  const DatabaseSync = getDatabaseSyncCtor(deps);
  if (typeof DatabaseSync !== 'function') return null;
  const dbFile = getModelAliasDbPath(aiHomeDir);
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = new DatabaseSync(dbFile);
  ensureAliasSchema(db);
  return db;
}

function rowToAlias(row) {
  return normalizeAliasRecord({
    id: row.id,
    alias: row.alias,
    target: row.target,
    provider: row.provider,
    targetProvider: row.target_provider,
    priority: row.priority,
    enabled: Number(row.enabled) !== 0,
    description: row.description
  });
}

function listAliasesFromDb(db) {
  const rows = db.prepare(`
    SELECT id, alias, target, provider, target_provider, priority, enabled, description
    FROM model_aliases
    ORDER BY created_at ASC, id ASC
  `).all() || [];
  return normalizeAliasData({ aliases: rows.map(rowToAlias) });
}

function replaceAliasesInDb(db, data) {
  const normalized = normalizeAliasData(data);
  const now = Date.now();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('DELETE FROM model_aliases').run();
    const insert = db.prepare(`
      INSERT INTO model_aliases (
        id, alias, target, provider, target_provider, priority, enabled, description, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    normalized.aliases.forEach((alias, index) => {
      insert.run(
        alias.id || generateAliasId(),
        alias.alias,
        alias.target,
        alias.provider,
        alias.targetProvider,
        normalizeAliasPriority(alias.priority),
        alias.enabled === false ? 0 : 1,
        alias.description || '',
        now + index,
        now
      );
    });
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (_rollbackError) {}
    throw error;
  }
  return normalized;
}

async function loadAliases(fs, aiHomeDir, deps = {}) {
  if (canUseAliasDatabase(fs, aiHomeDir, deps)) {
    let db = null;
    try {
      db = openAliasDatabase(fs, aiHomeDir, deps);
      return listAliasesFromDb(db);
    } finally {
      if (db && typeof db.close === 'function') {
        try { db.close(); } catch (_closeError) {}
      }
    }
  }
  return { aliases: [] };
}

async function saveAliases(fs, aiHomeDir, data, deps = {}) {
  const normalized = normalizeAliasData(data);
  if (canUseAliasDatabase(fs, aiHomeDir, deps)) {
    let db = null;
    try {
      db = openAliasDatabase(fs, aiHomeDir, deps);
      replaceAliasesInDb(db, normalized);
    } finally {
      if (db && typeof db.close === 'function') {
        try { db.close(); } catch (_closeError) {}
      }
    }
  }
  return normalized;
}

/**
 * Resolves the ordered candidate list for a requested model.
 * 排序规则:精确匹配组优先于通配符组;精确组内 priority 降序(同 priority 保持数组序,
 * 即 created_at 升序);通配符组内最长前缀优先,同前缀长度再按 priority 降序、数组序。
 * @param {Array} aliases - The list of alias objects.
 * @param {string} model - The requested model name.
 * @param {string} provider - The provider (e.g., 'claude', 'codex', 'gemini').
 * @returns {Array<{target: string, id: string, provider: string, targetProvider: string, priority: number, alias: string, matchType: string}>}
 */
function resolveAliasCandidates(aliases, model, provider) {
  if (!aliases || !Array.isArray(aliases)) return [];

  const requestProvider = normalizeRequestProvider(provider);
  const activeAliases = aliases
    .map((item, index) => ({ record: normalizeAliasRecord(item), index }))
    .filter(({ record }) => record.enabled !== false
      && (record.provider === 'all' || record.provider === requestProvider));

  const toCandidate = ({ record }, matchType) => ({
    target: record.target,
    id: record.id,
    provider: record.provider,
    targetProvider: record.targetProvider,
    priority: record.priority,
    alias: record.alias,
    matchType
  });

  const exactMatches = activeAliases
    .filter(({ record }) => record.alias === model)
    .sort((a, b) => (b.record.priority - a.record.priority) || (a.index - b.index))
    .map((item) => toCandidate(item, 'exact'));

  const wildcardMatches = activeAliases
    .filter(({ record }) => {
      if (!record.alias.endsWith('*')) return false;
      return model.startsWith(record.alias.slice(0, -1));
    })
    .sort((a, b) => {
      const prefixDelta = (b.record.alias.length - 1) - (a.record.alias.length - 1);
      if (prefixDelta !== 0) return prefixDelta;
      const priorityDelta = b.record.priority - a.record.priority;
      if (priorityDelta !== 0) return priorityDelta;
      return a.index - b.index;
    })
    .map((item) => toCandidate(item, 'wildcard'));

  return [...exactMatches, ...wildcardMatches];
}

/**
 * Resolves a model alias.
 * @param {Array} aliases - The list of alias objects.
 * @param {string} model - The requested model name.
 * @param {string} provider - The provider (e.g., 'claude', 'codex', 'gemini').
 * @returns {{target: string, id: string, provider: string, targetProvider: string}|null} - The resolved alias, or null if no match.
 */
function resolveAlias(aliases, model, provider) {
  const [first] = resolveAliasCandidates(aliases, model, provider);
  if (!first) return null;
  return {
    target: first.target,
    id: first.id,
    provider: first.provider,
    targetProvider: first.targetProvider
  };
}

function resolveAliasUpstreamProvider(alias) {
  const normalized = normalizeAliasRecord(alias);
  if (!normalized.target) return '';
  if (isSupportedProvider(normalized.targetProvider)) return normalized.targetProvider;
  return inferProviderFromModel(normalized.target);
}

module.exports = {
  ALIAS_SCOPE_PROVIDERS,
  ALIAS_TARGET_PROVIDERS,
  ALIASES_DB_FILE,
  generateAliasId,
  getModelAliasDbPath,
  loadAliases,
  normalizeAliasRecord,
  normalizeAliasScopeProvider,
  normalizeAliasTargetProvider,
  resolveAliasUpstreamProvider,
  saveAliases,
  resolveAlias,
  resolveAliasCandidates
};
