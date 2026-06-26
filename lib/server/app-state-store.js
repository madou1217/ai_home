'use strict';

const path = require('node:path');

const APP_STATE_DB_FILE = 'app-state.db';
const DEFAULT_BUSY_TIMEOUT_MS = 5000;

function getAppStateDbPath(aiHomeDir) {
  const root = String(aiHomeDir || '').trim();
  return root ? path.join(root, APP_STATE_DB_FILE) : '';
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

function openAppStateDatabase(fs, aiHomeDir, deps = {}) {
  const dbPath = getAppStateDbPath(aiHomeDir);
  const DatabaseSync = getDatabaseSyncCtor(deps);
  if (!dbPath || !fs || typeof fs.mkdirSync !== 'function' || typeof DatabaseSync !== 'function') return null;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA busy_timeout = ${DEFAULT_BUSY_TIMEOUT_MS};`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  return db;
}

function readJsonValue(fs, aiHomeDir, key, deps = {}) {
  const normalizedKey = String(key || '').trim();
  if (!normalizedKey) return null;
  let db = null;
  try {
    db = openAppStateDatabase(fs, aiHomeDir, deps);
    if (!db) return null;
    const row = db.prepare('SELECT value FROM app_kv WHERE key = ?').get(normalizedKey);
    if (!row || !row.value) return null;
    return JSON.parse(String(row.value));
  } catch (_error) {
    return null;
  } finally {
    if (db && typeof db.close === 'function') {
      try { db.close(); } catch (_closeError) {}
    }
  }
}

function writeJsonValue(fs, aiHomeDir, key, value, deps = {}) {
  const normalizedKey = String(key || '').trim();
  if (!normalizedKey) return;
  let db = null;
  try {
    db = openAppStateDatabase(fs, aiHomeDir, deps);
    if (!db) return;
    db.prepare(`
      INSERT INTO app_kv (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `).run(normalizedKey, JSON.stringify(value), Date.now());
  } catch (error) {
    if (!deps.bestEffort) throw error;
  } finally {
    if (db && typeof db.close === 'function') {
      try { db.close(); } catch (_closeError) {}
    }
  }
}

module.exports = {
  APP_STATE_DB_FILE,
  getAppStateDbPath,
  openAppStateDatabase,
  readJsonValue,
  writeJsonValue
};
