'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { MARKER_PREFIX, planDatabaseChanges, databaseFingerprint, applyDatabaseChanges } = require('./rekey-database');
const { buildFilesystemPlan, verifyFilesystemPlan } = require('./codex-rekey-inventory');
const { acquireRekeyLease } = require('./rekey-lease');
const { backupEditedFiles, applyFilesystem, restoreFilesystem, writeJournal, syncDirectory } = require('./rekey-journal');
const { createMaintenancePlan, writeMaintenancePlan, digestPlan, validatePlan, openDatabase, safeJournalDirectory } = require('./rekey-maintenance-plan');
const { createDatabaseBackup } = require('./rekey-backup');
const { assertRestoredState, closeMaintenanceResources } = require('./rekey-consistency');
const { recoverMaintenance } = require('./rekey-maintenance-recovery');
const { prepareNativeParticipants, applyNativeParticipants, restoreNativeParticipants } = require('./rekey-native-participant');

/**
 * The filesystem and SQLite are a Saga, not one imaginary transaction. Every
 * filesystem action is reversible; a marker committed with the SQL mutations
 * distinguishes pre-commit rollback from post-commit recovery after a crash.
 */
function applyMaintenancePlan(plan, options = {}) {
  validatePlan(plan, options.confirmDigest);
  if (!plan.mapping.length) return { status: 'nothing_to_do', migratedAccounts: 0 };
  const root = fs.realpathSync(plan.root);
  if (root !== plan.root) throw new Error('rekey_root_changed');
  const lease = acquireRekeyLease(root, { ...options.leaseOptions, mapping: plan.mapping });
  let db;
  let directory;
  let journal;
  let transaction = false;
  let commitAttempted = false;
  const failpoint = options.failpoint || (() => {});
  try {
    failpoint('after_gate', { id: lease.token, directory: safeJournalDirectory(root, lease.token) });
    const current = createMaintenancePlan(root, plan.providers);
    if (current.digest !== plan.digest) throw new Error('rekey_plan_stale');
    const id = lease.token;
    directory = safeJournalDirectory(root, id);
    const migrationRoot = path.dirname(directory);
    fs.mkdirSync(migrationRoot, { recursive: true, mode: 0o700 });
    if (fs.realpathSync(migrationRoot) !== migrationRoot) throw new Error('rekey_backup_directory_symlink');
    syncDirectory(fs, root);
    fs.mkdirSync(directory, { mode: 0o700 });
    syncDirectory(fs, migrationRoot);
    fs.chmodSync(directory, 0o700);
    journal = { version: 1, id, state: 'preparing', plan, planDigest: plan.digest };
    writeJournal(fs, directory, journal);
    backupEditedFiles(fs, root, directory, plan.filesystem);
    db = openDatabase(root, false);
    journal.databaseBackupHash = createDatabaseBackup(db, directory, plan.database.before.digest);
    prepareNativeParticipants(root, directory, journal);
    journal.state = 'prepared'; writeJournal(fs, directory, journal);
    db.exec('BEGIN IMMEDIATE; PRAGMA defer_foreign_keys=ON'); transaction = true;
    lease.assertQuiet();
    if (databaseFingerprint(db).digest !== plan.database.before.digest) throw new Error('rekey_database_changed');
    verifyFilesystemPlan(fs, root, '', new Map(plan.mapping), plan.filesystem);
    journal.state = 'applying'; writeJournal(fs, directory, journal);
    const checkpoint = (phase, index) => {
      journal.step = { phase, index }; writeJournal(fs, directory, journal);
      failpoint(phase, { id, index, directory });
    };
    applyNativeParticipants(root, directory, journal, checkpoint);
    applyFilesystem(fs, root, journal, checkpoint);
    const rewrittenRows = applyDatabaseChanges(db, plan.database.changes);
    failpoint('after_sql_updates', { id, directory });
    if (databaseFingerprint(db).digest !== plan.database.after.digest) throw new Error('rekey_post_state_mismatch');
    const remaining = planDatabaseChanges(db, new Map(plan.mapping));
    if (remaining.changes.length || remaining.blockers.length) throw new Error('rekey_machine_references_remaining');
    const afterFiles = buildFilesystemPlan(fs, root, '', new Map(plan.mapping), { observationPolicy: plan.filesystem.observationPolicy || 0 });
    if (afterFiles.edits.length || afterFiles.moves.length || afterFiles.links.length || afterFiles.nativeDatabases.length || afterFiles.blockers.length) {
      throw new Error('rekey_filesystem_references_remaining');
    }
    journal.filesystemAfter = afterFiles.fingerprint;
    journal.rewrittenRows = rewrittenRows;
    journal.state = 'commit_ready'; writeJournal(fs, directory, journal);
    lease.assertQuiet(); failpoint('before_commit', { id, directory });
    db.prepare('INSERT INTO app_kv(key,value,updated_at) VALUES(?,?,?)').run(MARKER_PREFIX + id, plan.digest, Date.now());
    commitAttempted = true;
    db.exec('COMMIT'); transaction = false;
    failpoint('after_commit', { id, directory });
    journal.state = 'completed'; writeJournal(fs, directory, journal);
    return { status: 'completed', id, migratedAccounts: plan.mapping.length, rewrittenRows,
      backupDirectory: directory, databaseInvariantVerified: true };
  } catch (error) {
    if (error.code === 'rekey_native_database_close_failed') {
      // Do not release exclusivity while a native connection may still exist.
      // Main DB close below rolls back an uncommitted transaction; a fresh
      // process then reconciles native state instead of guessing handle liveness.
      lease.retain();
      throw Object.assign(new Error('rekey_recovery_required'), { journalId: journal?.id, cause: error });
    }
    if (commitAttempted) {
      // COMMIT can become durable before its caller observes success. Never
      // compensate files from an in-memory boolean in this uncertainty window.
      // Closing rolls back an uncommitted transaction; recovery reads the marker
      // from a new connection and then chooses exactly one terminal state.
      lease.retain();
      throw Object.assign(new Error('rekey_commit_recovery_required'), { journalId: journal.id, cause: error });
    }
    try {
      if (transaction) { db.exec('ROLLBACK'); transaction = false; }
      if (journal) {
        restoreFilesystem(fs, root, directory, journal);
        restoreNativeParticipants(root, directory, journal);
        db ||= openDatabase(root, false);
        assertRestoredState(db, root, plan);
        journal.state = 'rolled_back'; writeJournal(fs, directory, journal);
      }
    } catch (recoveryError) {
      lease.retain();
      throw Object.assign(new Error('rekey_recovery_required'), { journalId: journal?.id, cause: recoveryError });
    }
    throw error;
  } finally {
    closeMaintenanceResources(db, lease, journal?.id);
  }
}

module.exports = { createMaintenancePlan, applyMaintenancePlan, recoverMaintenance, writeMaintenancePlan, digestPlan };
