'use strict';

const { ensureSharedStoreEntries, createSummary, pruneDanglingSharedLinks } = require('../../../../runtime/shared-store-linker');

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

const SHARED_ENTRY_SEGMENTS = Object.freeze([
  ...SHARED_DIR_ENTRIES,
  TASKS_INDEX_FILE,
  ...TASKS_INDEX_SIDECARS
]);

/**
 * 清掉投影根下指向宿主 `.zcode`、但宿主目标已不存在的链接。
 *
 * 旧版本把宿主 `.zcode` 下的每个条目都链进投影（`backup`、`computer-use`、…），
 * 现在只共享声明表里的条目，剩下的残留链接在宿主侧目标被删后就悬空。ZCode 的
 * 迁移备份在 `<dataRoot>/backup` 上做 `mkdir(recursive)`，悬空链接让这一步直接
 * ENOENT → 宿主进程 "Storage preparation failed: sql_failed" 起不来
 * （2026-11-03 真机）。删掉链接后应用自己把 `backup` 建出来。
 *
 * 每次启动都跑：只删「指向共享根且目标已消失」的一级链接，幂等。
 *
 * @param {{fs?: any, path?: any, sandboxDir: string, hostHomeDir: string}} input
 * @returns {{removed: string[], errors: string[]}}
 */
function repairZcodeProjectionLinks(input = {}) {
  const path = (input && input.path) || require('node:path');
  const sandboxDir = String(input && input.sandboxDir || '').trim();
  const hostHomeDir = String(input && input.hostHomeDir || '').trim();
  if (!sandboxDir || !hostHomeDir) {
    return { removed: [], errors: [] };
  }
  return pruneDanglingSharedLinks({
    fs: input && input.fs,
    path,
    projectionRoot: path.join(sandboxDir, '.zcode'),
    sharedRoot: path.join(hostHomeDir, '.zcode'),
    keep: SHARED_ENTRY_SEGMENTS
  });
}

/**
 * @param {{fs?: any, path?: any, sandboxDir: string, hostHomeDir: string}} input
 * @returns {{linked: number, discarded: number, adopted: number, pruned: string[], unresolved: string[], deferred: string, skipped: string, errors: string[]}}
 */
function ensureZcodeSharedSessionState(input = {}) {
  const path = (input && input.path) || require('node:path');
  const sandboxDir = String(input && input.sandboxDir || '').trim();
  const hostHomeDir = String(input && input.hostHomeDir || '').trim();
  if (!sandboxDir || !hostHomeDir) {
    return createSummary();
  }
  const summary = ensureSharedStoreEntries({
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
  const repaired = repairZcodeProjectionLinks(input);
  summary.pruned = repaired.removed;
  summary.errors.push(...repaired.errors.map((entry) => `prune:${entry}`));
  return summary;
}

module.exports = {
  ensureZcodeSharedSessionState,
  repairZcodeProjectionLinks,
  ZCODE_SHARED_DIR_ENTRIES: SHARED_DIR_ENTRIES,
  ZCODE_TASKS_INDEX_FILE: TASKS_INDEX_FILE,
  ZCODE_TASKS_INDEX_SIDECARS: TASKS_INDEX_SIDECARS
};

