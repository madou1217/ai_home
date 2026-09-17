'use strict';

const path = require('node:path');
const { sha256 } = require('./rekey-database');
const { lstatOptional } = require('./codex-rekey-inventory');
const { copyMetadataTemplate, inspectReplaceableMetadata } = require('./rekey-file-metadata');

const { syncDirectory } = require('../../../runtime/durable-directory');

function safePath(fs, root, relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) {
    throw new Error('rekey_journal_path_invalid');
  }
  const target = path.join(root, relative);
  const parent = fs.realpathSync(path.dirname(target));
  const canonical = fs.realpathSync(root);
  if (parent !== canonical && !parent.startsWith(`${canonical}${path.sep}`)) throw new Error('rekey_journal_path_escape');
  return target;
}

/** Atomic same-directory replacement, with a transaction-owned recoverable temp name. */
function atomicWrite(fs, file, bytes, mode, transaction, owner) {
  const temporary = `${file}.aih-rekey-${transaction}.tmp`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', mode);
    if (owner) {
      fs.closeSync(descriptor); descriptor = undefined;
      copyMetadataTemplate(fs, file, temporary, owner);
      descriptor = fs.openSync(temporary, 'r+');
      fs.ftruncateSync(descriptor, 0);
    }
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    if (owner && inspectReplaceableMetadata(temporary, fs.fstatSync(descriptor)) !== owner.metadataDigest) {
      throw new Error('rekey_metadata_changed_on_write');
    }
    fs.closeSync(descriptor); descriptor = undefined;
    fs.renameSync(temporary, file);
    syncDirectory(fs, path.dirname(file));
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (lstatOptional(fs, temporary)) fs.unlinkSync(temporary);
  }
}

function writeJournal(fs, directory, journal) {
  const text = JSON.stringify(journal);
  if (Buffer.byteLength(text) > 96 * 1024 * 1024) throw new Error('rekey_journal_size_limit');
  atomicWrite(fs, path.join(directory, 'journal.json'), text, 0o600, journal.id);
}

function backupEditedFiles(fs, root, directory, plan) {
  const backups = path.join(directory, 'files');
  fs.mkdirSync(backups, { mode: 0o700 });
  syncDirectory(fs, directory);
  for (const [index, edit] of plan.edits.entries()) {
    const source = safePath(fs, root, edit.source);
    const bytes = fs.readFileSync(source);
    if (sha256(bytes) !== edit.beforeHash) throw new Error('rekey_backup_source_changed');
    const target = path.join(backups, String(index));
    const descriptor = fs.openSync(target, 'wx', 0o600);
    try { fs.writeFileSync(descriptor, bytes); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  }
  syncDirectory(fs, backups);
}

function applyFilesystem(fs, root, journal, checkpoint) {
  const plan = journal.plan.filesystem;
  for (const [index, edit] of plan.edits.entries()) {
    const source = safePath(fs, root, edit.source);
    if (sha256(fs.readFileSync(source)) !== edit.beforeHash) throw new Error('rekey_edit_source_changed');
    checkpoint('before_edit', index);
    atomicWrite(fs, source, edit.content, edit.mode, journal.id, edit);
    checkpoint('after_edit', index);
  }
  for (const [index, link] of plan.links.entries()) {
    const source = safePath(fs, root, link.source);
    if (fs.readlinkSync(source) !== link.before) throw new Error('rekey_link_source_changed');
    checkpoint('before_link', index);
    const temporary = `${source}.aih-rekey-${journal.id}.tmp`;
    fs.symlinkSync(link.after, temporary);
    fs.renameSync(temporary, source);
    syncDirectory(fs, path.dirname(source));
    checkpoint('after_link', index);
  }
  for (const [index, move] of plan.moves.entries()) {
    const source = safePath(fs, root, move.source);
    const destination = safePath(fs, root, move.destination);
    if (lstatOptional(fs, destination)) throw new Error('rekey_move_target_exists');
    checkpoint('before_move', index);
    fs.renameSync(source, destination);
    syncDirectory(fs, path.dirname(source));
    checkpoint('after_move', index);
  }
}

/**
 * Recovery inspects before/after states rather than trusting the last written
 * step number. A crash can occur between an fs rename and journal fsync.
 * An ambiguous third state is refused; no unknown file is overwritten.
 */
function restoreFilesystem(fs, root, directory, journal, checkpoint = () => {}) {
  const plan = journal.plan.filesystem;
  for (const move of [...plan.moves].reverse()) {
    const source = safePath(fs, root, move.source);
    const destination = safePath(fs, root, move.destination);
    const original = lstatOptional(fs, source);
    const migrated = lstatOptional(fs, destination);
    if (original && !migrated) continue;
    if (!original && migrated && !migrated.isSymbolicLink()) {
      fs.renameSync(destination, source);
      syncDirectory(fs, path.dirname(source));
      checkpoint('rollback_after_move');
    } else throw new Error('rekey_recovery_move_ambiguous');
  }
  for (const link of [...plan.links].reverse()) {
    const source = safePath(fs, root, link.source);
    const current = fs.readlinkSync(source);
    if (current !== link.before && current !== link.after) throw new Error('rekey_recovery_link_changed');
    const temporary = `${source}.aih-rekey-${journal.id}.tmp`;
    if (lstatOptional(fs, temporary)) fs.unlinkSync(temporary);
    if (current === link.after) {
      fs.symlinkSync(link.before, temporary);
      fs.renameSync(temporary, source);
      syncDirectory(fs, path.dirname(source));
      checkpoint('rollback_after_link');
    }
  }
  for (const [index, edit] of [...plan.edits.entries()].reverse()) {
    const source = safePath(fs, root, edit.source);
    const stat = fs.lstatSync(source);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('rekey_recovery_file_changed');
    const current = sha256(fs.readFileSync(source));
    if (current !== edit.beforeHash && current !== edit.afterHash) throw new Error('rekey_recovery_file_changed');
    const temporary = `${source}.aih-rekey-${journal.id}.tmp`;
    if (lstatOptional(fs, temporary)) fs.unlinkSync(temporary);
    if (current === edit.afterHash) {
      const bytes = fs.readFileSync(path.join(directory, 'files', String(index)));
      if (sha256(bytes) !== edit.beforeHash) throw new Error('rekey_backup_checksum_mismatch');
      atomicWrite(fs, source, bytes, edit.mode, journal.id, edit);
      checkpoint('rollback_after_edit');
    }
  }
}

module.exports = { atomicWrite, backupEditedFiles, applyFilesystem, restoreFilesystem, writeJournal, syncDirectory, safePath };
