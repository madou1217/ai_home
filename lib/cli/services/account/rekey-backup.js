'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { databaseFingerprint } = require('./rekey-database');
const { syncDirectory } = require('../../../runtime/durable-directory');

/** Bounded hashing avoids loading a production-sized SQLite snapshot into RAM. */
function hashBackup(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
    || fs.realpathSync(file) !== file) throw new Error('rekey_backup_file_invalid');
  const fd = fs.openSync(file, 'r');
  try {
    const opened = fs.fstatSync(fd);
    if (opened.dev !== stat.dev || opened.ino !== stat.ino) throw new Error('rekey_backup_file_changed');
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.alloc(256 * 1024);
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!read) break;
      hash.update(buffer.subarray(0, read));
    }
    const after = fs.fstatSync(fd);
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error('rekey_backup_file_changed');
    return hash.digest('hex');
  } finally { fs.closeSync(fd); }
}

function createDatabaseBackup(db, directory, expectedFingerprint) {
  const file = path.join(directory, 'database.sqlite');
  const fd = fs.openSync(file, 'wx', 0o600);
  fs.closeSync(fd);
  db.exec(`VACUUM main INTO '${file.replace(/'/g, "''")}'`);
  const snapshot = new DatabaseSync(file, { readOnly: true });
  try {
    if (snapshot.prepare('PRAGMA quick_check').get().quick_check !== 'ok'
      || databaseFingerprint(snapshot).digest !== expectedFingerprint) throw new Error('rekey_database_backup_invalid');
  } finally { snapshot.close(); }
  // Do not publish 'prepared' until both the snapshot and its directory entry
  // have been flushed. This is protocol-level durability, not a hardware test.
  const durable = fs.openSync(file, 'r');
  try { fs.fsyncSync(durable); } finally { fs.closeSync(durable); }
  syncDirectory(fs, directory);
  return hashBackup(file);
}

module.exports = { hashBackup, createDatabaseBackup };
