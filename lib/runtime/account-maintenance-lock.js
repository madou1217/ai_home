'use strict';

const path = require('node:path');
const { ensurePrivateDirectory } = require('./durable-directory');

const DEFAULT_TIMEOUT_MS = 1000;

function lockError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function hasLeaseTable(db) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='lease'").get();
}

/**
 * Two first-time callers may both observe an empty file. Recheck under RESERVED
 * ownership before writing. A later initializer must ROLLBACK without writing:
 * even INSERT OR IGNORE would need an exclusive commit while a reader is alive.
 */
function initializeLockStore(db) {
  if (hasLeaseTable(db)) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    if (hasLeaseTable(db)) {
      db.exec('ROLLBACK');
      return;
    }
    const objects = db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all();
    if (objects.length) throw lockError('maintenance_lock_schema_invalid');
    db.exec('CREATE TABLE lease(id INTEGER PRIMARY KEY); INSERT INTO lease VALUES(1); COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (_) { /* The original failure is authoritative. */ }
    throw error;
  }
}

/**
 * OS-released SQLite rollback-journal locks: normal participants hold SHARED,
 * maintenance/recovery holds EXCLUSIVE. The coordination DB stores only one
 * constant row, never accounts or secrets. It is not the migration journal.
 */
function acquireAccountMaintenanceLock(fs, aiHomeDir, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 30000
    || (options.exclusive !== undefined && typeof options.exclusive !== 'boolean')) {
    throw lockError('maintenance_lock_options_invalid');
  }
  const DatabaseSync = options.DatabaseSync || require('node:sqlite').DatabaseSync;
  const root = fs.realpathSync(aiHomeDir);
  const run = path.join(aiHomeDir, 'run');
  const directory = path.join(run, 'maintenance');
  // Reader startup requires private directories, not a portable power-loss
  // durability promise. Durable recovery metadata uses the separate fsync API.
  ensurePrivateDirectory(fs, run);
  ensurePrivateDirectory(fs, directory);
  const canonical = fs.realpathSync(directory);
  if (!canonical.startsWith(`${root}${path.sep}`)) throw lockError('maintenance_lock_path_escape');
  const file = path.join(canonical, 'access.sqlite');
  for (const candidate of [file, `${file}-journal`, `${file}-wal`, `${file}-shm`]) {
    try {
      const item = fs.lstatSync(candidate);
      if (!item.isFile() || item.isSymbolicLink() || item.nlink > 1) throw lockError('maintenance_lock_file_invalid');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  let db;
  try {
    db = new DatabaseSync(file);
    fs.chmodSync(file, 0o600);
    db.exec(`PRAGMA busy_timeout=${timeoutMs}; PRAGMA synchronous=FULL`);
    if (db.prepare('PRAGMA journal_mode').get().journal_mode !== 'delete') throw lockError('maintenance_lock_mode_invalid');
    initializeLockStore(db);
    db.exec(options.exclusive ? 'BEGIN EXCLUSIVE' : 'BEGIN');
    const row = db.prepare('SELECT id FROM lease WHERE id=1').get();
    if (!row || row.id !== 1) throw lockError('maintenance_lock_schema_invalid');
    let closed = false;
    return {
      close() {
        if (closed) return;
        // DatabaseSync.close rolls back this transaction. Mark closed only after
        // success so a failed close can be retried without lying about ownership.
        db.close();
        closed = true;
      }
    };
  } catch (error) {
    db?.close();
    if ([5, 6].includes(Number(error.errcode) & 0xff) || /database.*(?:locked|busy)/i.test(error.message || '')) {
      throw lockError('account_maintenance_busy');
    }
    throw error;
  }
}

// This registry is process-local only. The cross-process authority is SQLite,
// not this Map, PID files, lsof output, or an elapsed-time "stale lock" heuristic.
const requestedProcessLeases = new Map();

function activateRequestedProcessLease(fs, aiHomeDir) {
  const registration = requestedProcessLeases.get(path.resolve(aiHomeDir));
  if (!registration || registration.lease) return;
  const { assertAccountMaintenanceAvailable, assertNoUnfinishedMaintenance } = require('./account-maintenance-gate');
  assertAccountMaintenanceAvailable(fs, aiHomeDir);
  const lease = acquireAccountMaintenanceLock(fs, aiHomeDir);
  try { assertAccountMaintenanceAvailable(fs, aiHomeDir); assertNoUnfinishedMaintenance(fs, aiHomeDir); }
  catch (error) { lease.close(); throw error; }
  registration.lease = lease;
}

/**
 * Normal CLI/server lifetime lease. A dedicated maintenance entrypoint must not
 * acquire it: separate SQLite connections cannot upgrade their own SHARED lock.
 * A fresh HOME stays untouched until the first real account database open.
 */
function holdAccountProcessLease(fs, aiHomeDir, processObj = process) {
  const key = path.resolve(aiHomeDir);
  const existing = requestedProcessLeases.get(key);
  if (existing) return existing.handle;
  const registration = { lease: null, closed: false };
  const onExit = () => registration.handle.close();
  registration.handle = {
    close() {
      if (registration.closed) return;
      registration.lease?.close();
      registration.closed = true;
      if (requestedProcessLeases.get(key) === registration) requestedProcessLeases.delete(key);
      processObj.removeListener?.('exit', onExit);
    }
  };
  requestedProcessLeases.set(key, registration);
  processObj.once('exit', onExit);
  try {
    if (fs.existsSync(aiHomeDir)) activateRequestedProcessLease(fs, aiHomeDir);
  } catch (error) {
    registration.handle.close();
    throw error;
  }
  return registration.handle;
}

module.exports = { acquireAccountMaintenanceLock, holdAccountProcessLease, activateRequestedProcessLease };
