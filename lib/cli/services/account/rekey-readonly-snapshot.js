'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync, backup } = require('node:sqlite');
const { openDatabase } = require('./rekey-maintenance-plan');
const { databaseFingerprint } = require('./rekey-database');
const { hashBackup } = require('./rekey-backup');
const { syncDirectory } = require('../../../runtime/durable-directory');

/**
 * Online SQLite backup from an explicitly read-only, pinned read transaction.
 * Do not copy a live main file without its committed WAL pages, and do not use
 * immutable=1 (which can ignore WAL). Source application processes may keep
 * writing: the receipt describes this snapshot, not a cross-resource stop point.
 */
async function snapshotReadonlyDatabase(sourceFile, destinationFile, options = {}) {
  const source = path.join(fs.realpathSync(path.dirname(path.resolve(sourceFile))), path.basename(sourceFile));
  const destination = path.join(fs.realpathSync(path.dirname(path.resolve(destinationFile))), path.basename(destinationFile));
  if (source === destination || fs.existsSync(destination)) throw new Error('rehearsal_snapshot_destination_exists');
  if (options.aihDatabase && path.basename(source) !== 'app-state.db') throw new Error('rehearsal_source_database_name_mismatch');
  const sourceStat = fs.lstatSync(source);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.nlink !== 1) {
    throw new Error('rehearsal_source_database_unsafe');
  }
  for (const sidecar of [`${source}-wal`, `${source}-shm`]) {
    try {
      const stat = fs.lstatSync(sidecar);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('rehearsal_source_sidecar_unsafe');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const parent = fs.realpathSync(path.dirname(destination));
  if (parent !== path.dirname(destination) || (fs.statSync(parent).mode & 0o077) !== 0) {
    throw new Error('rehearsal_snapshot_parent_not_private');
  }
  const descriptor = fs.openSync(destination, 'wx', 0o600); fs.closeSync(descriptor);
  const db = options.aihDatabase ? openDatabase(path.dirname(source), true) : new DatabaseSync(source, { readOnly: true });
  const started = Date.now();
  let transaction = false;
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=3000; BEGIN'); transaction = true;
    const before = databaseFingerprint(db);
    await backup(db, destination, { rate: 2048, progress() {
      if (Date.now() - started > (options.timeoutMs || 180000)) throw new Error('rehearsal_snapshot_timeout');
      return 2048;
    } });
    const copy = new DatabaseSync(destination);
    let after;
    try {
      // Normalize only the destination to a self-contained offline file. A
      // copied WAL-mode header otherwise makes verification create fresh WAL/SHM.
      copy.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE');
      if (copy.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('rehearsal_snapshot_integrity_failed');
      after = databaseFingerprint(copy);
    } finally { copy.close(); }
    if (before.digest !== after.digest) throw new Error('rehearsal_snapshot_content_mismatch');
    db.exec('ROLLBACK'); transaction = false;
    const fd = fs.openSync(destination, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    syncDirectory(fs, parent);
    return { logicalDigest: before.digest, counts: before.counts, bytes: fs.statSync(destination).size,
      byteDigest: hashBackup(destination), elapsedMs: Date.now() - started, sourceReadOnly: true, snapshotJournalMode: 'delete' };
  } finally {
    if (transaction) { try { db.exec('ROLLBACK'); } catch (_) { /* Closing releases the read snapshot. */ } }
    db.close();
  }
}

module.exports = { snapshotReadonlyDatabase };
