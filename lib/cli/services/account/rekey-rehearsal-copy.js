'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const scope = require('./rekey-inventory-scope');
const { snapshotNativeSqliteFiles } = require('./rekey-native-snapshot');
const { hashBackup } = require('./rekey-backup');
const { inspectReplaceableMetadata } = require('./rekey-file-metadata');

const SKIP = new Set(scope.skippedDirectories);
const TEXT = new Set(scope.textExtensions);

function sameFileVersion(before, after) {
  return before.dev === after.dev && before.ino === after.ino && before.size === after.size
    && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
}

function assertSourceParent(root, file) {
  const parent = fs.realpathSync(path.dirname(file));
  if (parent !== root && !parent.startsWith(root + path.sep)) throw new Error('rehearsal_source_path_escape');
}

function isNativeDatabase(relative) {
  return /(?:^|\/)\.codex\/(?:state|logs)_\d+\.sqlite$/.test(relative.split(path.sep).join('/'));
}

/**
 * Copy only the planner's named addressing scope. Excluded native history is
 * represented by its directory/link, never traversed. No artifact is executed.
 * Internal absolute links are relocated into the copy and recorded explicitly;
 * DB values are NOT rewritten, so the experiment cannot hide stale references.
 */
async function copyRehearsalScope(sourceRoot, copyRoot, options = {}) {
  const source = fs.realpathSync(sourceRoot);
  const copy = fs.realpathSync(copyRoot);
  if (source === copy || copy.startsWith(source + path.sep) || source.startsWith(copy + path.sep)) {
    throw new Error('rehearsal_roots_overlap');
  }
  if ((fs.statSync(copy).mode & 0o077) !== 0) throw new Error('rehearsal_copy_root_not_private');
  for (const existing of fs.readdirSync(copy)) {
    const stat = fs.lstatSync(path.join(copy, existing));
    if (existing !== 'app-state.db' || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      throw new Error('rehearsal_copy_root_not_empty');
    }
  }
  const metadataPaths = new Set(options.metadataPaths || []);
  for (const relative of metadataPaths) {
    if (typeof relative !== 'string' || !relative || path.isAbsolute(relative)
      || relative.split(/[\\/]/).includes('..')) throw new Error('rehearsal_edit_path_invalid');
  }
  const pending = scope.roots.filter(name => fs.existsSync(path.join(source, name)));
  for (const name of fs.readdirSync(source).sort()) {
    if (TEXT.has(path.extname(name)) && !fs.lstatSync(path.join(source, name)).isDirectory()) pending.push(name);
  }
  const records = [];
  const directoryModes = [];
  let copiedBytes = 0;
  let visited = 0;
  for (; pending.length;) {
    const relative = pending.pop();
    if (relative === path.join('run', 'maintenance') || relative.startsWith(path.join('run', 'maintenance') + path.sep)) continue;
    if (++visited > (options.maxEntries || 250000)) throw new Error('rehearsal_entry_budget_exceeded');
    const from = path.join(source, relative), to = path.join(copy, relative);
    assertSourceParent(source, from);
    const before = fs.lstatSync(from);
    const mode = before.mode & 0o777;
    if (scope.roots.includes(relative) && before.isSymbolicLink()) throw new Error('rehearsal_scope_root_is_link');
    if (before.isDirectory()) {
      fs.mkdirSync(to, { recursive: true, mode: 0o700 }); directoryModes.push([to, mode]);
      const omitted = SKIP.has(path.basename(from));
      records.push({ path: relative, type: 'directory', omittedChildren: omitted });
      if (!omitted) for (const child of fs.readdirSync(from).sort().reverse()) pending.push(path.join(relative, child));
    } else if (before.isSymbolicLink()) {
      fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
      const original = fs.readlinkSync(from);
      const relocated = path.isAbsolute(original) && (original === source || original.startsWith(source + path.sep))
        ? copy + original.slice(source.length) : original;
      fs.symlinkSync(relocated, to);
      if (fs.readlinkSync(from) !== original) throw new Error('rehearsal_source_link_changed');
      records.push({ path: relative, type: 'link', relocated: relocated !== original });
    } else if (before.isFile()) {
      if (before.nlink > 1) throw new Error('rehearsal_source_hardlink');
      // Native Codex SQLite snapshots are self-contained; do not mix them with
      // separately copied live WAL/SHM files from a different generation.
      if (/-(?:wal|shm)$/.test(relative) && isNativeDatabase(relative.slice(0, -4))) {
        records.push({ path: relative, type: 'sidecar', materializedWithDatabase: true }); continue;
      }
      copiedBytes += before.size;
      if (copiedBytes > (options.maxBytes || 8 * 1024 ** 3)) throw new Error('rehearsal_byte_budget_exceeded');
      fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
      if (isNativeDatabase(relative)) {
        const receipt = await snapshotNativeSqliteFiles(from, to);
        records.push({ path: relative, type: 'native-sqlite', logicalDigest: receipt.logicalDigest, bytes: receipt.bytes, captureMethod: receipt.captureMethod, sourceFileVersionsUnchanged: receipt.sourceFileVersionsUnchanged });
      } else {
        const fd = fs.openSync(from, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try {
          if (!sameFileVersion(before, fs.fstatSync(fd))) throw new Error('rehearsal_source_file_changed');
          fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE);
          assertSourceParent(source, from);
          if (!sameFileVersion(before, fs.fstatSync(fd)) || !sameFileVersion(before, fs.lstatSync(from))) {
            throw new Error('rehearsal_source_file_changed');
          }
        } finally { fs.closeSync(fd); }
        fs.chmodSync(to, mode); fs.utimesSync(to, before.atime, before.mtime);
        const record = { path: relative, type: 'file', bytes: before.size };
        if (metadataPaths.has(relative)) {
          // Preserve metadata at the SAME per-file capture point, not after a
          // long directory traversal when a live application may have updated it.
          const digest = hashBackup(to);
          const metadata = inspectReplaceableMetadata(from, before);
          const args = process.platform === 'darwin' ? ['-p', from, to] : ['--preserve=all', '--', from, to];
          execFileSync('/bin/cp', args, { stdio: 'pipe', timeout: 10000 });
          if (!sameFileVersion(before, fs.lstatSync(from)) || hashBackup(to) !== digest
            || inspectReplaceableMetadata(to, fs.lstatSync(to)) !== metadata) {
            throw new Error('rehearsal_source_edit_changed');
          }
          record.byteDigest = digest; record.metadataDigest = metadata;
        }
        records.push(record);
      }
    } else throw new Error('rehearsal_source_special_file');
  }
  if ([...metadataPaths].some(relative => !records.some(record => record.path === relative && record.metadataDigest))) {
    throw new Error('rehearsal_metadata_source_missing');
  }
  for (const [directory, mode] of directoryModes.reverse()) fs.chmodSync(directory, mode);
  return { records, visited, copiedBytes, externalLinksFollowed: 0 };
}

module.exports = { copyRehearsalScope, isNativeDatabase, sameFileVersion };
