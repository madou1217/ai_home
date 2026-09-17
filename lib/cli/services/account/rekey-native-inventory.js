'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { snapshotNativeSqliteFilesSync } = require('./rekey-native-snapshot');
const { inspectReplaceableMetadata } = require('./rekey-file-metadata');
const { nativeStoreKind, nativeFingerprint, planNativeReferences } = require('./rekey-native-policy');

/**
 * Inspection opens only a private copied file set. A SQL read-only connection
 * can still recreate SHM on a native WAL store; that is not allowed on source.
 * The original file set's versions are verified by the shared snapshot adapter.
 */
function inspectNativeStore(root, relative, mapping) {
  const source = path.join(root, relative), kind = nativeStoreKind(relative);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-native-rekey-inspection-'));
  fs.chmodSync(temporary, 0o700);
  let db;
  try {
    snapshotNativeSqliteFilesSync(source, path.join(temporary, 'copy.sqlite'));
    db = new DatabaseSync(path.join(temporary, 'copy.sqlite'), { readOnly: true });
    const references = planNativeReferences(db, mapping, kind);
    const before = nativeFingerprint(db), after = nativeFingerprint(db, references.changes);
    const stat = fs.lstatSync(source);
    return { source: relative, kind, before, after, ...references,
      mode: stat.mode & 0o777, uid: stat.uid, gid: stat.gid,
      metadataDigest: references.changes.length ? inspectReplaceableMetadata(source, stat) : '' };
  } finally {
    db?.close();
    // Owned private scratch only; never a native source, account directory or
    // caller-selected cleanup target. No credential copy survives inspection.
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

module.exports = { inspectNativeStore };
