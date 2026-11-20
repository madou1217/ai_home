'use strict';

/**
 * Web 构建的共享缓存位置（跨 worktree 一份，不再落进每个 `node_modules/.cache`）。
 *
 * 为什么需要：webpack 的持久缓存单份就有 2.9G（.pack 文件），以前它跟着
 * `node_modules` 走——每个工作树 / 每个手工副本各一份，删了源码树之前先撑爆磁盘。
 * 缓存是可再生的构建产物，天然应该按"项目"共享，而不是按"目录副本"各自一份。
 *
 * 项目身份用 git 的 common-dir（worktree 共用同一个 .git）而不是绝对路径：
 * 同一个仓库的所有 worktree 命中同一份缓存；不同项目互不干扰。
 *
 * 覆盖：设置 AIH_SHARED_CACHE_DIR 可以把整棵共享缓存挪到别的卷（CI/容器用）。
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

/** 宿主家目录：账号投影里的 HOME 是伪 HOME，缓存不能落进投影（会跟着账号各一份）。 */
function hostHome() {
  try {
    const { resolveUnprojectedHostHomeDir } = require('../../lib/runtime/host-home');
    const resolved = resolveUnprojectedHostHomeDir();
    if (resolved) return resolved;
  } catch (_error) { /* web 单独构建时没有 lib/，退回 os.homedir */ }
  return os.homedir();
}

function sharedCacheRoot() {
  const override = String(process.env.AIH_SHARED_CACHE_DIR || '').trim();
  if (override) return path.resolve(override);
  return path.join(hostHome(), '.ai_home', 'shared-cache');
}

/** 仓库身份（worktree 共享）：git common-dir 的真实路径，退不回就按仓库根。 */
function projectKey(webRoot) {
  const root = path.resolve(webRoot, '..');
  let identity = '';
  try {
    const common = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    if (common) identity = path.resolve(root, common);
  } catch (_error) { /* 非 git 环境按路径区分 */ }
  if (!identity) identity = root;
  return crypto.createHash('sha256').update(identity).digest('hex').slice(0, 16);
}

/** webpack 持久缓存目录（每个项目一份）。 */
function webpackCacheDir(webRoot) {
  return path.join(sharedCacheRoot(), 'webpack', projectKey(webRoot));
}

/** 构建排队锁（等待式，跨 worktree 串行构建，避免同时写同一份缓存）。 */
function buildQueueLockPath(webRoot) {
  return path.join(sharedCacheRoot(), 'webpack', projectKey(webRoot) + '.queue.lock');
}

/** 构建互斥锁（直接跑 build.cjs 时的 fail-fast 锁）。 */
function buildMutexLockDir(webRoot) {
  return path.join(sharedCacheRoot(), 'webpack', projectKey(webRoot) + '.mutex.lock');
}

/** 清掉长期没构建的项目缓存（默认 30 天），避免共享目录只增不减。 */
function pruneWebpackCaches(options = {}) {
  const root = path.join(options.root || sharedCacheRoot(), 'webpack');
  const maxAgeDays = Number.isFinite(options.maxAgeDays) ? options.maxAgeDays : 30;
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  const removed = [];
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (_error) { return removed; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const target = path.join(root, entry.name);
    let info = null;
    try { info = fs.statSync(target); } catch (_error) { continue; }
    if (Number(info.mtimeMs) >= cutoff) continue;
    try {
      fs.rmSync(target, { recursive: true, force: true });
      removed.push(target);
    } catch (_error) { /* 正在被占用就下次再说 */ }
  }
  return removed;
}

module.exports = {
  buildMutexLockDir,
  buildQueueLockPath,
  projectKey,
  pruneWebpackCaches,
  sharedCacheRoot,
  webpackCacheDir
};
