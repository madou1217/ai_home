'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { MARKER_PREFIX, databaseFingerprint, applyDatabaseChanges } = require('./rekey-database');
const { assertRestoredState, assertFilesystemState, closeMaintenanceResources } = require('./rekey-consistency');
const { hashBackup } = require('./rekey-backup');
const { acquireRekeyLease } = require('./rekey-lease');
const { restoreFilesystem, writeJournal, syncDirectory } = require('./rekey-journal');
const { openDatabase, transactionMarker, safeJournalDirectory, readJournal } = require('./rekey-maintenance-plan');
const { restoreNativeParticipants, verifyNativeBackups } = require('./rekey-native-participant');

/**
 * A crash may occur after the gate is durable but before the first journal is
 * published. No DB/FS mutation precedes that journal. Reconcile only that exact
 * owner's empty preparation; a marker or unexpected file is an explicit stop.
 */
function recoverUnpublishedPreparation(root, id, options) {
  const lease = acquireRekeyLease(root, { ...options.leaseOptions, recover: true, operationId: id });
  let db;
  try {
    // acquireRekeyLease has atomically taken ownership; validate the requested
    // ID against its prior owner metadata captured under the OS lock.
    if (lease.previousOperationId !== id) throw new Error('rekey_preparation_owner_mismatch');
    db = openDatabase(root, false);
    if (transactionMarker(db, id)) throw new Error('rekey_preparation_marker_present');
    const directory = safeJournalDirectory(root, id);
    if (fs.existsSync(directory)) {
      const temporary = `journal.json.aih-rekey-${id}.tmp`;
      const names = fs.readdirSync(directory);
      if (names.some(name => name !== temporary)) throw new Error('rekey_preparation_state_ambiguous');
      if (names.length) {
        const file = path.join(directory, temporary);
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) throw new Error('rekey_preparation_state_ambiguous');
        fs.unlinkSync(file);
      }
      fs.rmdirSync(directory); syncDirectory(fs, path.dirname(directory));
    }
    return { status: 'rolled_back', id, reason: 'no_mutations_started', databaseInvariantVerified: true };
  } catch (error) { lease.retain(); throw error; }
  finally { closeMaintenanceResources(db, lease, id); }
}

/** Recover interrupted work, or explicitly undo a completed and still-quiet migration. */
function recoverMaintenance(aiHomeDir, id, options = {}) {
  const root = fs.realpathSync(aiHomeDir);
  let preliminary;
  try { preliminary = readJournal(root, id); }
  catch (error) {
    if (error.code === 'ENOENT' && options.rollback !== true) return recoverUnpublishedPreparation(root, id, options);
    throw error;
  }
  const rollback = options.rollback === true;
  const lease = acquireRekeyLease(root, { ...options.leaseOptions, mapping: preliminary.journal.plan.mapping, recover: !rollback, operationId: id });
  let db;
  let transaction = false;
  try {
    // Re-read under exclusive ownership, with every subsequent failure covered
    // by the same gate-retention / OS-lock-release finally boundary.
    const { directory, journal } = readJournal(root, id);
    if (journal.planDigest !== preliminary.journal.planDigest) throw new Error('rekey_journal_changed');
    const pendingJournal = path.join(directory, `journal.json.aih-rekey-${id}.tmp`);
    if (fs.existsSync(pendingJournal)) {
      const stat = fs.lstatSync(pendingJournal);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) throw new Error('rekey_pending_journal_invalid');
      fs.unlinkSync(pendingJournal); syncDirectory(fs, directory);
    }
    db = openDatabase(root, false);
    lease.assertQuiet();
    db.exec('BEGIN IMMEDIATE; PRAGMA defer_foreign_keys=ON'); transaction = true;
    const backupPath = path.join(directory, 'database.sqlite');
    if (journal.databaseBackupHash && hashBackup(backupPath) !== journal.databaseBackupHash) {
      throw new Error('rekey_backup_checksum_mismatch');
    }
    const marker = transactionMarker(db, id);
    if (marker && marker !== journal.planDigest) throw new Error('rekey_commit_marker_mismatch');
    if (marker) {
      verifyNativeBackups(directory, journal);
      if (databaseFingerprint(db, [], MARKER_PREFIX + id).digest !== journal.plan.database.after.digest) {
        throw new Error('rekey_post_commit_writes_detected');
      }
      const rollbackPending = journal.state === 'rollback_requested';
      if (!rollbackPending) {
        assertFilesystemState(root, journal.plan, journal.filesystemAfter, true);
      }
      if (rollback || rollbackPending) {
        // Persist intent before reversing either resource. A crash during rollback
        // must resume rollback, not misclassify restored files as outside writes.
        journal.state = 'rollback_requested'; writeJournal(fs, directory, journal);
        restoreFilesystem(fs, root, directory, journal, phase => options.failpoint?.(phase, { id, directory }));
        restoreNativeParticipants(root, directory, journal, (phase, index) => options.failpoint?.(phase, { id, index, directory }));
        applyDatabaseChanges(db, journal.plan.database.changes, true);
        db.prepare('DELETE FROM app_kv WHERE key=?').run(MARKER_PREFIX + id);
        assertRestoredState(db, root, journal.plan);
        journal.state = 'rolled_back';
      } else journal.state = 'completed';
    } else {
      if (databaseFingerprint(db).digest !== journal.plan.database.before.digest) throw new Error('rekey_pre_commit_state_changed');
      restoreFilesystem(fs, root, directory, journal);
      restoreNativeParticipants(root, directory, journal);
      assertRestoredState(db, root, journal.plan);
      journal.state = 'rolled_back';
    }
    options.failpoint?.('recovery_before_commit', { id, directory });
    db.exec('COMMIT'); transaction = false;
    options.failpoint?.('recovery_after_commit', { id, directory });
    writeJournal(fs, directory, journal);
    return { status: journal.state, id, databaseInvariantVerified: true };
  } catch (error) {
    lease.retain();
    if (transaction) { try { db.exec('ROLLBACK'); } catch (_) { /* Fresh recovery resolves an ambiguous COMMIT. */ } }
    throw Object.assign(new Error('rekey_recovery_required'), { journalId: id, cause: error });
  } finally { closeMaintenanceResources(db, lease, id); }
}

module.exports = { recoverMaintenance };
