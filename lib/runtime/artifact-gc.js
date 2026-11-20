'use strict';

/**
 * 构件回收（GC）：把账号投影里"只增不删"的东西按保留策略收回去。
 *
 * 与 `projection-artifacts.js` 分工：那个负责**建立共享**，这个负责**回收残留**。
 * 两者都只碰"可再生"内容——凭据、会话库、provider 配置永远不在删除范围内。
 *
 * 安全前提（宁可少删，不可删错）：
 *   - 版本构件被任何存活进程引用（argv 或已打开文件）时跳过；
 *   - 在用的判定"探测失败"也按在用处理（失败即保守）；
 *   - 删除一律先 rename 进回收站，宽限期后再真正 unlink，留出反悔窗口。
 */

const nodeFs = require('node:fs');
const nodePath = require('node:path');
const { execFileSync } = require('node:child_process');

const { VERSION_ROOTS, compareVersions, ensureDirectoryWritable, listVersionArtifacts, makeTreeRemovable } = require('./version-artifacts');

/** 进程正在使用的路径集合（argv + 已打开文件）。失败返回 null = 未知。 */
function snapshotInUsePaths(deps = {}) {
  if (typeof deps.snapshotInUsePaths === 'function') return deps.snapshotInUsePaths();
  const platform = String(deps.platform || process.platform).toLowerCase();
  const paths = new Set();
  try {
    if (platform === 'win32') {
      // Windows：只取命令行。新版 Windows 已移除 wmic，退回 PowerShell CIM；
      // 两者都失败才按"未知"处理（宁可不删）。
      let output = '';
      try {
        output = execFileSync('wmic', ['process', 'get', 'CommandLine'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
      } catch (_error) {
        output = execFileSync('powershell', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { $_.CommandLine }'], { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] });
      }
      for (const line of output.split(/\r?\n/)) collectPathTokens(line, paths);
      return paths;
    }
    // macOS / Linux：argv
    const ps = execFileSync('ps', ['-axo', 'command='], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    for (const line of ps.split('\n')) collectPathTokens(line, paths);
    // macOS / Linux：已打开文件
    try {
      const lsof = execFileSync('lsof', ['-nP', '-F', 'n'], { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] });
      for (const line of lsof.split('\n')) {
        if (line.startsWith('n/')) paths.add(line.slice(1));
      }
    } catch (_error) { /* 没有 lsof：只靠 argv，仍比不判定安全 */ }
    return paths;
  } catch (_error) {
    return null;
  }
}

function collectPathTokens(line, sink) {
  const text = String(line || '');
  if (!text) return;
  for (const token of text.split(/\s+/)) {
    if (token.startsWith('/') && token.length > 1) sink.add(token.replace(/["']/g, ''));
  }
}

function isPathInUse(paths, target) {
  if (!paths) return true; // 未知 = 按在用处理
  const normalized = nodePath.resolve(target);
  for (const candidate of paths) {
    if (candidate === normalized || candidate.startsWith(`${normalized}${nodePath.sep}`)) return true;
  }
  return false;
}

/**
 * 回收旧版本：每个 (cli) 只保留最新 `keepVersions` 个。
 * @returns {Array<{path:string, reason:string, sizeBytes:number}>}
 */
function pruneVersions(options = {}) {
  const fs = options.fs || nodeFs;
  const projectionRoot = String(options.projectionRoot || '').trim();
  const keepVersions = Number.isFinite(options.keepVersions) ? options.keepVersions : 2;
  const inUse = options.inUsePaths === undefined ? snapshotInUsePaths(options.deps) : options.inUsePaths;
  const removed = [];
  if (!projectionRoot) return removed;

  const byCli = new Map();
  for (const artifact of listVersionArtifacts({ fs, projectionRoot })) {
    if (!byCli.has(artifact.cli)) byCli.set(artifact.cli, []);
    byCli.get(artifact.cli).push(artifact);
  }
  for (const [, artifacts] of byCli) {
    artifacts.sort((left, right) => compareVersions(left.version, right.version));
    const stale = artifacts.slice(0, Math.max(0, artifacts.length - keepVersions));
    for (const artifact of stale) {
      if (isPathInUse(inUse, artifact.path)) continue;
      const sizeBytes = pathSizeBytes(fs, artifact.path);
      if (options.dryRun) {
        removed.push({ path: artifact.path, reason: 'old-version', sizeBytes, dryRun: true });
        continue;
      }
      try {
        moveToTrash(fs, artifact.path, options.trashDir);
        removed.push({ path: artifact.path, reason: 'old-version', sizeBytes });
      } catch (_error) { /* 单个失败不影响其它 */ }
    }
  }
  return removed;
}

/** 按年龄回收日志/追踪目录（只删内容，不删目录本身，避免应用重建失败）。 */
function pruneLogs(options = {}) {
  const fs = options.fs || nodeFs;
  const projectionRoot = String(options.projectionRoot || '').trim();
  const maxAgeDays = Number.isFinite(options.maxAgeDays) ? options.maxAgeDays : 14;
  const removed = [];
  if (!projectionRoot || maxAgeDays <= 0) return removed;
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  const parents = options.parents || ['.codebuddy-cn', '.codebuddy', '.workbuddy-ai', '.workbuddy', '.qoder', '.qoder-cn'];
  const names = options.dirNames || ['traces', 'logs'];

  for (const parent of parents) {
    for (const name of names) {
      const directory = nodePath.join(projectionRoot, parent, name);
      let entries = [];
      try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch (_error) { continue; }
      for (const entry of entries) {
        const target = nodePath.join(directory, entry.name);
        let info = null;
        try { info = fs.statSync(target); } catch (_error) { continue; }
        const lastWrite = Math.max(Number(info.mtimeMs) || 0, Number(info.atimeMs) || 0);
        if (lastWrite >= cutoff) continue;
        if (entry.isDirectory() && isDirectoryRecentlyWritten(fs, target, cutoff)) continue;
        const sizeBytes = pathSizeBytes(fs, target);
        if (options.dryRun) {
          removed.push({ path: target, reason: `stale-${name}`, sizeBytes, dryRun: true });
          continue;
        }
        try {
          moveToTrash(fs, target, options.trashDir);
          removed.push({ path: target, reason: `stale-${name}`, sizeBytes });
        } catch (_error) { /* 单个失败不影响其它 */ }
      }
    }
  }
  return removed;
}

function isDirectoryRecentlyWritten(fs, directory, cutoff) {
  let entries = [];
  try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch (_error) { return true; }
  for (const entry of entries) {
    const target = nodePath.join(directory, entry.name);
    let info = null;
    try { info = fs.statSync(target); } catch (_error) { continue; }
    if (Math.max(Number(info.mtimeMs) || 0, Number(info.atimeMs) || 0) >= cutoff) return true;
    if (entry.isDirectory() && isDirectoryRecentlyWritten(fs, target, cutoff)) return true;
  }
  return false;
}

function pathSizeBytes(fs, target) {
  let total = 0;
  const walk = (current) => {
    let info = null;
    try { info = fs.lstatSync(current); } catch (_error) { return; }
    if (info.isSymbolicLink()) return; // 不跟随链接，避免把共享目标算成本地占用
    if (info.isFile()) { total += Number(info.size) || 0; return; }
    if (!info.isDirectory()) return;
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch (_error) { return; }
    for (const entry of entries) walk(nodePath.join(current, entry.name));
  };
  walk(target);
  return total;
}

/**
 * 回收构件库里过期的版本树：每个 (provider, cli, platform) 只保留最新 N 份。
 *
 * 库里的树是"所有账号共用的一份"，不回收就会随每次 CLI 升级无限长大。
 * 安全边界：
 *   - 投影里仍有**符号链接**指向它的树绝不删（删了会直接把账号弄坏）；
 *     reflink/硬链接的投影不受影响（删掉库内名字后，投影自己的副本/链接仍然有效）；
 *   - 进程正在用（argv/打开文件）的树不删；
 *   - 拿不到投影根就整个跳过（无法证明没人引用就不动）。
 *
 * @returns {Array<{path:string, reason:string, sizeBytes:number}>}
 */
function pruneStoreTrees(options = {}) {
  const fs = options.fs || nodeFs;
  const storeRoot = String(options.storeRoot || '').trim();
  const projectionsRoot = String(options.projectionsRoot || '').trim();
  const keepVersions = Number.isFinite(options.keepVersions) ? options.keepVersions : 2;
  const removed = [];
  if (!storeRoot || !projectionsRoot) return removed;
  // 平台列在这里只是分组维度，不改变保留策略。
  const treesDir = nodePath.join(storeRoot, 'trees');
  let entries = [];
  try { entries = fs.readdirSync(treesDir, { withFileTypes: true }); } catch (_error) { return removed; }
  const groups = new Map();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;
    const parts = entry.name.split('__');
    if (parts.length !== 4) continue;
    const [provider, cli, version, platform] = parts;
    const groupKey = [provider, cli, platform].join('__');
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey).push({ provider, cli, version, platform, path: nodePath.join(treesDir, entry.name) });
  }
  const symlinked = collectSymlinkedVersionTargets(fs, projectionsRoot);
  // 投影里仍装着的版本一律保留：reflink/硬链接投影删掉库内树不会坏，但下次启动又要
  // 重新物化一份；按"版本名"判定比按路径判定更稳，也顺带覆盖了符号链接。
  const referencedKeys = collectProjectionVersionKeys(fs, projectionsRoot, options.platform);
  const inUse = options.inUsePaths === undefined ? snapshotInUsePaths(options.deps) : options.inUsePaths;
  for (const [, artifacts] of groups) {
    artifacts.sort((left, right) => compareVersions(left.version, right.version));
    const stale = artifacts.slice(0, Math.max(0, artifacts.length - keepVersions));
    for (const artifact of stale) {
      const key = [artifact.provider, artifact.cli, artifact.version, artifact.platform].join('__');
      if (referencedKeys.has(key)) continue;
      if (symlinked.has(nodePath.resolve(artifact.path))) continue;
      if (isPathInUse(inUse, artifact.path)) continue;
      const sizeBytes = pathSizeBytes(fs, artifact.path);
      if (options.dryRun) {
        removed.push({ path: artifact.path, reason: 'stale-store-tree', sizeBytes, dryRun: true });
        continue;
      }
      try {
        moveToTrash(fs, artifact.path, options.trashDir);
        try { fs.rmSync(artifact.path + '.fingerprint.json', { force: true }); } catch (_error) { /* noop */ }
        removed.push({ path: artifact.path, reason: 'stale-store-tree', sizeBytes });
      } catch (_error) { /* 单个失败不影响其它 */ }
    }
  }
  return removed;
}

/** 所有账号投影里仍在使用的版本（provider__cli__version__platform）。 */
function collectProjectionVersionKeys(fs, projectionsRoot, platform) {
  const keys = new Set();
  const targetPlatform = String(platform || process.platform || '').toLowerCase();
  let providers = [];
  try { providers = fs.readdirSync(projectionsRoot, { withFileTypes: true }); } catch (_error) { return keys; }
  for (const providerEntry of providers) {
    if (!providerEntry.isDirectory()) continue;
    const providerRoot = nodePath.join(projectionsRoot, providerEntry.name);
    let accounts = [];
    try { accounts = fs.readdirSync(providerRoot, { withFileTypes: true }); } catch (_error) { continue; }
    for (const accountEntry of accounts) {
      if (!accountEntry.isDirectory()) continue;
      const accountRoot = nodePath.join(providerRoot, accountEntry.name);
      for (const declaration of VERSION_ROOTS) {
        const versionsDir = nodePath.join(accountRoot, ...declaration.root);
        let names = [];
        try { names = fs.readdirSync(versionsDir); } catch (_error) { continue; }
        for (const name of names) {
          keys.add([providerEntry.name, declaration.cli, name, targetPlatform].join('__'));
        }
      }
    }
  }
  return keys;
}

/** 所有账号投影里，以符号链接方式指向构件库的版本路径（这些库内树不能删）。 */
function collectSymlinkedVersionTargets(fs, projectionsRoot) {
  const targets = new Set();
  let providers = [];
  try { providers = fs.readdirSync(projectionsRoot, { withFileTypes: true }); } catch (_error) { return targets; }
  for (const providerEntry of providers) {
    if (!providerEntry.isDirectory()) continue;
    const providerRoot = nodePath.join(projectionsRoot, providerEntry.name);
    let accounts = [];
    try { accounts = fs.readdirSync(providerRoot, { withFileTypes: true }); } catch (_error) { continue; }
    for (const accountEntry of accounts) {
      if (!accountEntry.isDirectory()) continue;
      const accountRoot = nodePath.join(providerRoot, accountEntry.name);
      for (const declaration of VERSION_ROOTS) {
        const versionsDir = nodePath.join(accountRoot, ...declaration.root);
        let names = [];
        try { names = fs.readdirSync(versionsDir); } catch (_error) { continue; }
        for (const name of names) {
          const candidate = nodePath.join(versionsDir, name);
          let info = null;
          try { info = fs.lstatSync(candidate); } catch (_error) { continue; }
          if (!info.isSymbolicLink()) continue;
          try { targets.add(nodePath.resolve(nodePath.dirname(candidate), fs.readlinkSync(candidate))); } catch (_error) { /* noop */ }
        }
      }
    }
  }
  return targets;
}

/** 先 rename 进回收站（同卷，原子），宽限期后由 `emptyTrash` 真正删除。 */
function moveToTrash(fs, target, trashDir) {
  const root = String(trashDir || '').trim();
  // 只读树必须先放开目录写权限：macOS 连"改名目录"都要求目录自身可写。
  makeTreeRemovable(fs, target);
  ensureDirectoryWritable(fs, nodePath.dirname(target));
  if (!root) {
    fs.rmSync(target, { recursive: true, force: true });
    return;
  }
  fs.mkdirSync(root, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const destination = nodePath.join(root, `${stamp}-${nodePath.basename(target)}-${process.pid}`);
  fs.renameSync(target, destination);
  // 宽限期从移入时间算；rename 会保留源目录的旧 mtime，不重置就会被同轮 GC 立刻删掉。
  const now = new Date();
  try { fs.utimesSync(destination, now, now); } catch (_error) { /* 时间戳只影响宽限期 */ }
}

/** 清空回收站里超过宽限期的条目。 */
function emptyTrash(options = {}) {
  const fs = options.fs || nodeFs;
  const trashDir = String(options.trashDir || '').trim();
  const graceDays = Number.isFinite(options.graceDays) ? options.graceDays : 7;
  const removed = [];
  if (!trashDir || graceDays < 0) return removed;
  const cutoff = Date.now() - graceDays * 24 * 60 * 60 * 1000;
  let entries = [];
  try { entries = fs.readdirSync(trashDir, { withFileTypes: true }); } catch (_error) { return removed; }
  for (const entry of entries) {
    const target = nodePath.join(trashDir, entry.name);
    let info = null;
    try { info = fs.statSync(target); } catch (_error) { continue; }
    if ((Number(info.mtimeMs) || 0) >= cutoff) continue;
    const sizeBytes = pathSizeBytes(fs, target);
    try {
      makeTreeRemovable(fs, target);
      fs.rmSync(target, { recursive: true, force: true });
      removed.push({ path: target, sizeBytes });
    } catch (_error) { /* noop */ }
  }
  return removed;
}

module.exports = {
  emptyTrash,
  isPathInUse,
  moveToTrash,
  pathSizeBytes,
  pruneLogs,
  pruneStoreTrees,
  pruneVersions,
  snapshotInUsePaths
};
