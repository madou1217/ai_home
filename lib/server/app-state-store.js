'use strict';

const path = require('node:path');

const APP_STATE_DB_FILE = 'app-state.db';
const DEFAULT_BUSY_TIMEOUT_MS = 5000;
const PRIVATE_FILE_MODE = 0o600;

function listTableInfo(db, tableName) {
  const normalizedName = String(tableName || '').trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(normalizedName)) {
    throw new Error('invalid_app_state_table_name');
  }
  return db.prepare(`PRAGMA table_info(${normalizedName})`).all() || [];
}

function listTableColumns(db, tableName) {
  return listTableInfo(db, tableName)
    .map((row) => String(row && row.name || '').trim())
    .filter(Boolean);
}

function listPrimaryKeyColumns(tableInfo) {
  return (Array.isArray(tableInfo) ? tableInfo : [])
    .filter((row) => Number(row && row.pk) > 0)
    .sort((left, right) => Number(left.pk) - Number(right.pk))
    .map((row) => String(row.name || '').trim())
    .filter(Boolean);
}

function listUniqueKeys(db, tableName) {
  return (db.prepare('SELECT name FROM pragma_index_list(?) WHERE "unique" = 1').all(tableName) || [])
    .map((index) => (db.prepare('SELECT name FROM pragma_index_info(?) ORDER BY seqno').all(index.name) || [])
      .map((column) => String(column && column.name || '').trim())
      .filter(Boolean))
    .filter((columns) => columns.length > 0);
}

function includesColumnList(collection, expected) {
  return collection.some((columns) => columns.length === expected.length
    && expected.every((column, index) => columns[index] === column));
}

function ensureExactTableSchema(db, options = {}) {
  const tableName = String(options.tableName || '').trim();
  const expectedColumns = Array.isArray(options.columns) ? options.columns : [];
  const errorCode = String(options.errorCode || '').trim() || 'app_state_schema_invalid';
  let tableInfo = listTableInfo(db, tableName);
  if (tableInfo.length === 0 && typeof options.create === 'function') {
    options.create();
    tableInfo = listTableInfo(db, tableName);
  }
  const columns = tableInfo.map((row) => String(row && row.name || '').trim()).filter(Boolean);
  const valid = columns.length === expectedColumns.length
    && expectedColumns.every((column, index) => columns[index] === column);
  const expectedPrimaryKey = Array.isArray(options.primaryKey) ? options.primaryKey : null;
  const actualPrimaryKey = listPrimaryKeyColumns(tableInfo);
  const validPrimaryKey = expectedPrimaryKey === null
    || (
      actualPrimaryKey.length === expectedPrimaryKey.length
      && expectedPrimaryKey.every((column, index) => actualPrimaryKey[index] === column)
    );
  const expectedUniqueKeys = Array.isArray(options.uniqueKeys) ? options.uniqueKeys : [];
  const actualUniqueKeys = expectedUniqueKeys.length > 0 ? listUniqueKeys(db, tableName) : [];
  const validUniqueKeys = expectedUniqueKeys.every((keyColumns) => (
    Array.isArray(keyColumns) && includesColumnList(actualUniqueKeys, keyColumns)
  ));
  if (!valid || !validPrimaryKey || !validUniqueKeys) throw new Error(errorCode);
}

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

function hardenDatabaseFiles(fs, dbPath) {
  if (!fs || typeof fs.chmodSync !== 'function' || !dbPath) return;
  [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].forEach((filePath) => {
    try {
      if (typeof fs.existsSync !== 'function' || fs.existsSync(filePath)) {
        fs.chmodSync(filePath, PRIVATE_FILE_MODE);
      }
    } catch (_error) {}
  });
}

function openAppStateDatabase(fs, aiHomeDir, deps = {}) {
  const dbPath = getAppStateDbPath(aiHomeDir);
  const DatabaseSync = getDatabaseSyncCtor(deps);
  if (!dbPath || !fs || typeof fs.mkdirSync !== 'function' || typeof DatabaseSync !== 'function') return null;
  const createIfMissing = deps.createIfMissing !== false;
  if (!createIfMissing) {
    if (typeof fs.existsSync !== 'function' || !fs.existsSync(dbPath)) return null;
  }
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    // Set the lock wait before WAL negotiation or schema initialization. When
    // several fresh processes open the same database, journal_mode itself can
    // require the writer lock.
    db.exec(`PRAGMA busy_timeout = ${DEFAULT_BUSY_TIMEOUT_MS}`);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA foreign_keys = ON');
    hardenDatabaseFiles(fs, dbPath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS app_kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    hardenDatabaseFiles(fs, dbPath);
    return db;
  } catch (error) {
    try { db.close(); } catch (_closeError) {}
    throw error;
  }
}

function readJsonValue(fs, aiHomeDir, key, deps = {}) {
  const normalizedKey = String(key || '').trim();
  if (!normalizedKey) return null;
  let db = null;
  try {
    db = openAppStateDatabase(fs, aiHomeDir, { ...deps, createIfMissing: false });
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
  if (!normalizedKey) return false;
  let db = null;
  try {
    db = openAppStateDatabase(fs, aiHomeDir, deps);
    if (!db) return false;
    db.prepare(`
      INSERT INTO app_kv (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `).run(normalizedKey, JSON.stringify(value), Date.now());
    return true;
  } catch (error) {
    if (deps.bestEffort) return false;
    throw error;
  } finally {
    if (db && typeof db.close === 'function') {
      try { db.close(); } catch (_closeError) {}
    }
  }
}

function deleteJsonValue(fs, aiHomeDir, key, deps = {}) {
  const normalizedKey = String(key || '').trim();
  if (!normalizedKey) return false;
  let db = null;
  try {
    db = openAppStateDatabase(fs, aiHomeDir, { ...deps, createIfMissing: false });
    if (!db) return false;
    const result = db.prepare('DELETE FROM app_kv WHERE key = ?').run(normalizedKey);
    return Number(result && result.changes) > 0;
  } catch (error) {
    if (deps.bestEffort) return false;
    throw error;
  } finally {
    if (db && typeof db.close === 'function') {
      try { db.close(); } catch (_closeError) {}
    }
  }
}

module.exports = {
  APP_STATE_DB_FILE,
  deleteJsonValue,
  ensureExactTableSchema,
  getAppStateDbPath,
  hardenDatabaseFiles,
  listTableColumns,
  openAppStateDatabase,
  readJsonValue,
  writeJsonValue
};
