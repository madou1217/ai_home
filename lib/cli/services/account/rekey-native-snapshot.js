'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { databaseFingerprint } = require('./rekey-database');
const { hashBackup } = require('./rekey-backup');
const { syncDirectory } = require('../../../runtime/durable-directory');

function version(stat) {
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
}

function sourceFiles(main) {
  return ['', '-wal', '-shm', '-journal'].flatMap(suffix => {
    const file = main + suffix;
    let stat;
    try { stat = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    if (suffix === '-journal' && stat.size > 0) throw new Error('rehearsal_native_rollback_journal_unsupported');
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('rehearsal_native_file_unsafe');
    return [{ file, suffix, version: version(stat), bytes: stat.size }];
  });
}

/**
 * Some idle native WAL databases need to rebuild SHM even for SQL read-only
 * access. Never permit that write on the original just to inspect it. Capture
 * the ordinary file set only while ALL source inode versions remain unchanged,
 * verify copied bytes against a second source read, then let SQLite recover
 * strictly inside a private staging directory. No source SQLite connection is
 * opened here. Changing native stores cause refusal, not an inconsistent copy.
 */
async function snapshotNativeSqliteFiles(sourceFile, destinationFile, options = {}) {
  const source = path.join(fs.realpathSync(path.dirname(sourceFile)), path.basename(sourceFile));
  const destination = path.join(fs.realpathSync(path.dirname(destinationFile)), path.basename(destinationFile));
  if (source === destination || fs.existsSync(destination)) throw new Error('rehearsal_snapshot_destination_exists');
  if ((fs.statSync(path.dirname(destination)).mode & 0o077) !== 0) throw new Error('rehearsal_snapshot_parent_not_private');
  const inputs = sourceFiles(source);
  if (!inputs.some(row => row.suffix === '')) throw new Error('rehearsal_native_main_missing');
  if (inputs.reduce((sum, row) => sum + row.bytes, 0) > (options.maxBytes || 1024 ** 3)) {
    throw new Error('rehearsal_native_size_limit');
  }
  const staging = fs.mkdtempSync(path.join(path.dirname(destination), '.native-snapshot-'));
  fs.chmodSync(staging, 0o700);
  let database;
  try {
    for (const input of inputs) {
      const descriptor = fs.openSync(input.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        if (version(fs.fstatSync(descriptor)) !== input.version) throw new Error('rehearsal_native_source_changed');
        // SHM is reader coordination, not committed database content. It is
        // checked for source stability but rebuilt only in the private copy.
        if (input.suffix !== '-shm') {
          const target = path.join(staging, 'native.sqlite' + input.suffix);
          fs.copyFileSync(input.file, target, fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE);
          fs.chmodSync(target, 0o600);
          if (hashBackup(target) !== hashBackup(input.file)) throw new Error('rehearsal_native_copy_mismatch');
        }
        if (version(fs.fstatSync(descriptor)) !== input.version) throw new Error('rehearsal_native_source_changed');
      } finally { fs.closeSync(descriptor); }
    }
    const after = sourceFiles(source);
    if (JSON.stringify(after) !== JSON.stringify(inputs)) throw new Error('rehearsal_native_source_changed');
    const stageFile = path.join(staging, 'native.sqlite');
    database = new DatabaseSync(stageFile);
    database.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE');
    if (database.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('rehearsal_native_integrity_failed');
    const logical = databaseFingerprint(database);
    database.close(); database = null;
    const descriptor = fs.openSync(stageFile, 'r');
    try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    // O_EXCL equivalent for publication: never replace a caller-owned file.
    fs.copyFileSync(stageFile, destination, fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE);
    fs.chmodSync(destination, 0o600);
    const out = fs.openSync(destination, 'r'); try { fs.fsyncSync(out); } finally { fs.closeSync(out); }
    syncDirectory(fs, path.dirname(destination));
    return { captureMethod: 'stable-native-file-set', sourceSqlOpened: false,
      sourceFileVersionsUnchanged: true, sourceFiles: inputs.length,
      logicalDigest: logical.digest, counts: logical.counts, bytes: fs.statSync(destination).size };
  } finally {
    database?.close();
    // This path is created above, never supplied by the caller or source data.
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

module.exports = { snapshotNativeSqliteFiles };
