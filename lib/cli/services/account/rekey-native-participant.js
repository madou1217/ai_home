'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { safePath, syncDirectory, writeJournal } = require('./rekey-journal');
const { nativeFingerprint } = require('./rekey-native-policy');
const { applyDatabaseChanges } = require('./rekey-database');
const { hashBackup } = require('./rekey-backup');
const { inspectReplaceableMetadata } = require('./rekey-file-metadata');
const { assertNoDatabaseOpeners } = require('./rekey-lease');

function openNative(root, plan, recovery = false) {
  const file = safePath(fs, root, plan.source);
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    let stat;
    try { stat = fs.lstatSync(file + suffix); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('rekey_native_file_unsafe');
    if (suffix === '-journal' && stat.size && !recovery) throw new Error('rekey_native_hot_journal_requires_recovery');
    assertNoDatabaseOpeners(file + suffix);
  }
  if (inspectReplaceableMetadata(file, fs.lstatSync(file)) !== plan.metadataDigest) throw new Error('rekey_native_metadata_changed');
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000; PRAGMA synchronous=FULL');
    return db;
  } catch (error) { db.close(); throw error; }
}

function closeNative(db) {
  try { db.close(); }
  catch (cause) {
    throw Object.assign(new Error('rekey_native_database_close_failed'), { code: 'rekey_native_database_close_failed', cause });
  }
}

/** Back up every participant before any one of them is allowed to commit. */
function prepareNativeParticipants(root, directory, journal) {
  const plans = journal.plan.filesystem.nativeDatabases || [];
  if (!plans.length) return;
  const target = path.join(directory, 'native');
  fs.mkdirSync(target, { mode: 0o700 }); syncDirectory(fs, directory);
  journal.nativeBackups = [];
  for (const [index, plan] of plans.entries()) {
    const db = openNative(root, plan);
    const backup = path.join(target, `${index}.sqlite`);
    try {
      if (nativeFingerprint(db).digest !== plan.before.digest) throw new Error('rekey_native_plan_stale');
      const fd = fs.openSync(backup, 'wx', 0o600); fs.closeSync(fd);
      db.exec(`VACUUM main INTO '${backup.replace(/'/g, "''")}'`);
      const copy = new DatabaseSync(backup, { readOnly: true });
      try {
        if (copy.prepare('PRAGMA quick_check').get().quick_check !== 'ok'
          || nativeFingerprint(copy).digest !== plan.before.digest) throw new Error('rekey_native_backup_invalid');
      } finally { copy.close(); }
      const durable = fs.openSync(backup, 'r'); try { fs.fsyncSync(durable); } finally { fs.closeSync(durable); }
      syncDirectory(fs, target);
      journal.nativeBackups.push({ index, hash: hashBackup(backup) });
      writeJournal(fs, directory, journal);
    } finally { closeNative(db); }
  }
}

function verifyNativeBackup(directory, journal, index) {
  const receipt = journal.nativeBackups?.find(value => value.index === index);
  if (!receipt || hashBackup(path.join(directory, 'native', `${index}.sqlite`)) !== receipt.hash) {
    throw new Error('rekey_native_backup_checksum_mismatch');
  }
}

function verifyNativeBackups(directory, journal) {
  for (const [index] of (journal.plan.filesystem.nativeDatabases || []).entries()) {
    verifyNativeBackup(directory, journal, index);
  }
}

/**
 * A killed DELETE-mode write may leave a cold nonempty rollback journal whose
 * zero header tells SQLite no recovery is needed. Do not unlink it ourselves.
 * Only after verifying the entire restored logical state, ask SQLite to leave
 * and re-enter DELETE mode; SQLite owns deciding when its journal can be removed.
 * This runs outside a transaction and leaves the original persistent mode intact.
 */
function settleRestoredNative(db, file, expected, checkpoint) {
  if (nativeFingerprint(db).digest !== expected) throw new Error('rekey_native_rollback_state_mismatch');
  let journal;
  try { journal = fs.lstatSync(file + '-journal'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!journal || !journal.size) return;
  const mode = db.prepare('PRAGMA journal_mode').get().journal_mode;
  if (mode !== 'delete') throw new Error('rekey_native_journal_mode_unexpected');
  db.exec('PRAGMA journal_mode=TRUNCATE');
  checkpoint('during_native_journal_settlement');
  db.exec('PRAGMA journal_mode=DELETE');
  if (db.prepare('PRAGMA journal_mode').get().journal_mode !== mode
    || nativeFingerprint(db).digest !== expected) throw new Error('rekey_native_journal_settlement_failed');
  syncDirectory(fs, path.dirname(file));
}

/**
 * Each native DB is a Saga participant. Its full before/after logical state is
 * the completion evidence; no foreign migration table is added to vendor data.
 * An ambiguous COMMIT is re-read on a fresh connection by compensation/recovery.
 * Close before account-directory rename so SQLite never follows a moved WAL.
 */
function applyNativeParticipants(root, directory, journal, checkpoint = () => {}) {
  const plans = journal.plan.filesystem.nativeDatabases || [];
  for (const [index, plan] of plans.entries()) {
    verifyNativeBackup(directory, journal, index);
    const db = openNative(root, plan);
    try {
      db.exec('BEGIN IMMEDIATE; PRAGMA defer_foreign_keys=ON');
      if (nativeFingerprint(db).digest !== plan.before.digest) throw new Error('rekey_native_plan_stale');
      checkpoint('before_native_update', index);
      applyDatabaseChanges(db, plan.changes);
      if (nativeFingerprint(db).digest !== plan.after.digest) throw new Error('rekey_native_post_state_mismatch');
      checkpoint('before_native_commit', index);
      db.exec('COMMIT');
      checkpoint('after_native_commit', index);
    } finally { closeNative(db); }
    checkpoint('after_native_close', index);
  }
}

/** Filesystem compensation must restore directory names before this is called. */
function restoreNativeParticipants(root, directory, journal, checkpoint = () => {}) {
  const plans = journal.plan.filesystem.nativeDatabases || [];
  for (const [index, plan] of [...plans.entries()].reverse()) {
    // A killed native transaction can leave a hot rollback journal. Only this
    // journal-owned recovery path lets SQLite undo it, then proves the entire
    // committed state is exactly before or after; unknown states remain gated.
    const db = openNative(root, plan, true);
    try {
      db.exec('BEGIN IMMEDIATE; PRAGMA defer_foreign_keys=ON');
      const current = nativeFingerprint(db).digest;
      if (current === plan.before.digest) {
        db.exec('ROLLBACK');
        settleRestoredNative(db, safePath(fs, root, plan.source), plan.before.digest, phase => checkpoint(phase, index));
        continue;
      }
      if (current !== plan.after.digest) throw new Error('rekey_native_post_commit_writes_detected');
      verifyNativeBackup(directory, journal, index);
      applyDatabaseChanges(db, plan.changes, true);
      if (nativeFingerprint(db).digest !== plan.before.digest) throw new Error('rekey_native_rollback_state_mismatch');
      checkpoint('before_native_rollback_commit', index);
      db.exec('COMMIT');
      checkpoint('after_native_rollback_commit', index);
      settleRestoredNative(db, safePath(fs, root, plan.source), plan.before.digest, phase => checkpoint(phase, index));
    } finally { closeNative(db); }
  }
}

module.exports = { prepareNativeParticipants, applyNativeParticipants, restoreNativeParticipants, verifyNativeBackups };
