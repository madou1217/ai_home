'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { databaseFingerprint } = require('./rekey-database');
const { buildFilesystemPlan } = require('./codex-rekey-inventory');
const { inspectReplaceableMetadata } = require('./rekey-file-metadata');

/** Apply the same child-before-parent move sequence to a recorded file address. */
function migratedPath(relative, moves) {
  let current = relative;
  for (const move of moves) {
    if (current === move.source || current.startsWith(`${move.source}${path.sep}`)) {
      current = move.destination + current.slice(move.source.length);
    }
  }
  return current;
}

function assertEditedMetadata(root, plan, migrated) {
  for (const native of plan.filesystem.nativeDatabases || []) {
    const relative = migrated ? migratedPath(native.source, plan.filesystem.moves) : native.source;
    const file = path.join(root, relative);
    if (inspectReplaceableMetadata(file, fs.lstatSync(file)) !== native.metadataDigest) throw new Error('rekey_native_metadata_changed');
  }
  for (const edit of plan.filesystem.edits) {
    const relative = migrated ? migratedPath(edit.source, plan.filesystem.moves) : edit.source;
    const file = path.join(root, relative);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()
      || inspectReplaceableMetadata(file, stat) !== edit.metadataDigest) {
      throw new Error('rekey_restored_metadata_mismatch');
    }
  }
}

/**
 * Successful compensation is a checked state, not just 'all undo calls returned'.
 * An unrelated machine file changed during interruption must remain untouched
 * and keep the gate closed, rather than be certified as the original snapshot.
 */
function assertFilesystemState(root, plan, expectedFingerprint, migrated = false) {
  const current = buildFilesystemPlan(fs, root, '', new Map(plan.mapping));
  if (current.fingerprint !== expectedFingerprint) throw new Error('rekey_filesystem_state_mismatch');
  assertEditedMetadata(root, plan, migrated);
  return current;
}

function assertRestoredState(db, root, plan) {
  if (databaseFingerprint(db).digest !== plan.database.before.digest) {
    throw new Error('rekey_database_rollback_state_mismatch');
  }
  assertFilesystemState(root, plan, plan.filesystem.fingerprint);
}

/** A native close failure keeps the durable gate closed for fresh-process recovery. */
function closeMaintenanceResources(db, lease, journalId) {
  try { db?.close(); }
  catch (error) {
    lease.retain();
    throw Object.assign(new Error('rekey_database_close_failed'), { journalId, cause: error });
  } finally { lease.release(); }
}

module.exports = { migratedPath, assertFilesystemState, assertRestoredState, closeMaintenanceResources };
