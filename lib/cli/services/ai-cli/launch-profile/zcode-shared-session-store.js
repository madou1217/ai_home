'use strict';

/**
 * ZCode shared session store.
 *
 * ZCode keeps every piece of state under one data root (`<base>/.zcode`):
 * identity (v2/credentials.json, v2/config.json, v2/setting.json) must stay
 * account-private inside the projection, while conversation/project state
 * (v2/tasks-index.sqlite + v2/sessions + v2/session-bindings + v2/checkpoints,
 * cli/, workspace/, plugin-workspace/) should be visible from every account's
 * client — sessions are not bound to an account.
 *
 * ZCode offers no env knob to split those two groups, so this module links the
 * session entries from each account projection into the real host `~/.zcode`
 * (the canonical shared store, same convention as other providers' session
 * store). Directories become junctions; the tasks-index SQLite trio becomes
 * file symlinks.
 *
 * SQLite WAL notes (verified on Windows):
 * - Locking/IO goes through the symlink to the shared target inode, so
 *   concurrent clients share one WAL safely.
 * - A clean close deletes `<db>-wal` via the projection path, which removes
 *   only that projection's symlink. The shared target survives, and the next
 *   launch re-creates the link (this module runs on every launch).
 * - A dangling wal/shm symlink is intentional: SQLite creating the wal through
 *   the link creates the shared target file.
 *
 * Identity files (credentials.json, config.json, setting.json, caches, logs)
 * are never linked — they stay per-account by design.
 *
 * No migration, no backups: whatever real (non-link) data a projection holds
 * at a shared path is disposable sandbox residue and is deleted in place
 * before the link is created. The host `~/.zcode` is the single source of
 * truth; nothing is ever copied or moved out of a projection.
 */

const SHARED_DIR_ENTRIES = Object.freeze([
  Object.freeze(['cli']),
  Object.freeze(['workspace']),
  Object.freeze(['plugin-workspace']),
  Object.freeze(['v2', 'sessions']),
  Object.freeze(['v2', 'session-bindings']),
  Object.freeze(['v2', 'checkpoints'])
]);

const TASKS_INDEX_FILE = Object.freeze(['v2', 'tasks-index.sqlite']);
const TASKS_INDEX_SIDEcars = Object.freeze([
  Object.freeze(['v2', 'tasks-index.sqlite-wal']),
  Object.freeze(['v2', 'tasks-index.sqlite-shm'])
]);

function normalizeForCompare(value) {
  return String(value || '').replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();
}

function createSummary() {
  return { linked: 0, discarded: 0, errors: [] };
}

/**
 * @param {{fs: any, path: any, sandboxDir: string, hostHomeDir: string}} input
 * @returns {{linked: number, discarded: number, errors: string[]}}
 */
function ensureZcodeSharedSessionState(input) {
  const fs = (input && input.fs) || require('node:fs');
  const path = (input && input.path) || require('node:path');
  const sandboxDir = String(input && input.sandboxDir || '').trim();
  const hostHomeDir = String(input && input.hostHomeDir || '').trim();
  const summary = createSummary();
  if (!sandboxDir || !hostHomeDir) return summary;
  // Fail-closed: never link the projection back into itself when the sandbox
  // already IS the host home (e.g. provider running without auth projection).
  if (normalizeForCompare(sandboxDir) === normalizeForCompare(hostHomeDir)) return summary;

  const projectionRoot = path.join(sandboxDir, '.zcode');
  const sharedRoot = path.join(hostHomeDir, '.zcode');

  const lstat = (p) => {
    try {
      return fs.lstatSync(p);
    } catch (error) {
      if (error && error.code === 'ENOENT') return null;
      throw error;
    }
  };

  const linkPointsTo = (linkPath, target) => {
    try {
      const resolved = path.resolve(path.dirname(linkPath), fs.readlinkSync(linkPath));
      return normalizeForCompare(resolved) === normalizeForCompare(target);
    } catch (_error) {
      return false;
    }
  };

  // Real (non-link) data at a shared path is projection residue. It is never
  // copied, moved, or backed up — just deleted so the shared link can take
  // its place.
  const discardRealEntry = (srcPath, stat) => {
    if (stat.isDirectory()) fs.rmSync(srcPath, { recursive: true, force: true });
    else fs.unlinkSync(srcPath);
    summary.discarded += 1;
  };

  const ensureDirLink = (segments) => {
    const src = path.join(projectionRoot, ...segments);
    const dst = path.join(sharedRoot, ...segments);
    const stat = lstat(src);
    if (stat && stat.isSymbolicLink()) {
      if (linkPointsTo(src, dst)) return;
      fs.unlinkSync(src);
    } else if (stat) {
      discardRealEntry(src, stat);
    }
    fs.mkdirSync(dst, { recursive: true });
    fs.mkdirSync(path.dirname(src), { recursive: true });
    fs.symlinkSync(dst, src, 'junction');
    summary.linked += 1;
  };

  const ensureFileLink = (segments, options = {}) => {
    const src = path.join(projectionRoot, ...segments);
    const dst = path.join(sharedRoot, ...segments);
    const stat = lstat(src);
    if (stat && stat.isSymbolicLink()) {
      if (linkPointsTo(src, dst)) return;
      fs.unlinkSync(src);
    } else if (stat) {
      discardRealEntry(src, stat);
    }
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    if (!lstat(dst) && options.dangling !== true) {
      // An empty file is a valid fresh SQLite database; wal/shm stay dangling
      // on purpose — SQLite creates the shared target through the link.
      fs.writeFileSync(dst, '');
    }
    fs.mkdirSync(path.dirname(src), { recursive: true });
    fs.symlinkSync(dst, src, 'file');
    summary.linked += 1;
  };

  const run = (label, fn) => {
    try {
      fn();
    } catch (error) {
      summary.errors.push(`${label}:${error && error.code ? error.code : 'error'}`);
    }
  };

  for (const segments of SHARED_DIR_ENTRIES) {
    run(segments.join('/'), () => ensureDirLink(segments));
  }
  run(TASKS_INDEX_FILE.join('/'), () => ensureFileLink(TASKS_INDEX_FILE));
  for (const segments of TASKS_INDEX_SIDEcars) {
    run(segments.join('/'), () => ensureFileLink(segments, { dangling: true }));
  }
  return summary;
}

module.exports = {
  ensureZcodeSharedSessionState,
  ZCODE_SHARED_DIR_ENTRIES: SHARED_DIR_ENTRIES,
  ZCODE_TASKS_INDEX_FILE: TASKS_INDEX_FILE,
  ZCODE_TASKS_INDEX_SIDECARS: TASKS_INDEX_SIDEcars
};
