'use strict';

const { ensureSharedStoreEntries, createSummary } = require('../../../../runtime/shared-store-linker');

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
 * ZCode offers no env knob to split those two groups, so this module declares
 * the shareable entries and hands them to the provider-agnostic linker
 * (lib/runtime/shared-store-linker.js), which links them into the real host
 * `~/.zcode` (the canonical shared store, same convention as other providers'
 * session store). Directories become junctions; the tasks-index SQLite trio
 * becomes file symlinks.
 *
 * Identity files (credentials.json, config.json, setting.json, caches, logs)
 * are never linked — they stay per-account by design.
 *
 * No migration, no backups: whatever real (non-link) data a projection holds
 * at a shared path is disposable sandbox residue and is deleted in place
 * before the link is created (`discardRealEntries: true`). The host `~/.zcode`
 * is the single source of truth; nothing is ever copied or moved out of a
 * projection. (Providers whose projection holds real user conversations use the
 * linker's `adopt` hook instead — see cline-shared-session-store.js.)
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
const TASKS_INDEX_SIDECARS = Object.freeze([
  Object.freeze(['v2', 'tasks-index.sqlite-wal']),
  Object.freeze(['v2', 'tasks-index.sqlite-shm'])
]);

/**
 * @param {{fs?: any, path?: any, sandboxDir: string, hostHomeDir: string}} input
 * @returns {{linked: number, discarded: number, adopted: number, unresolved: string[], deferred: string, skipped: string, errors: string[]}}
 */
function ensureZcodeSharedSessionState(input = {}) {
  const path = (input && input.path) || require('node:path');
  const sandboxDir = String(input && input.sandboxDir || '').trim();
  const hostHomeDir = String(input && input.hostHomeDir || '').trim();
  if (!sandboxDir || !hostHomeDir) {
    return createSummary();
  }
  return ensureSharedStoreEntries({
    fs: input && input.fs,
    path,
    projectionRoot: path.join(sandboxDir, '.zcode'),
    sharedRoot: path.join(hostHomeDir, '.zcode'),
    dirEntries: SHARED_DIR_ENTRIES,
    fileEntries: [TASKS_INDEX_FILE],
    sidecarEntries: TASKS_INDEX_SIDECARS,
    // zcode 投影里的会话/任务数据是派生残留，可安全丢弃后建链（历史行为）。
    discardRealEntries: true
  });
}

module.exports = {
  ensureZcodeSharedSessionState,
  ZCODE_SHARED_DIR_ENTRIES: SHARED_DIR_ENTRIES,
  ZCODE_TASKS_INDEX_FILE: TASKS_INDEX_FILE,
  ZCODE_TASKS_INDEX_SIDECARS: TASKS_INDEX_SIDECARS
};

