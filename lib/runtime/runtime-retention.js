'use strict';

const nodeFs = require('node:fs');
const nodePath = require('node:path');

// `~/.ai_home/run` 的运行期保留策略（2026-11-01）。
//
// 这些目录是**可再生的运行态**，不是账号数据：
//   run/login/<provider>/<authId>     登录沙箱（每次登录一份伪 HOME）
//   run/chat-harness/<scope>          WebUI 聊天的 harness 运行时
//   run/verification/*                验证产物
// 它们只增不减曾是 ~/.ai_home 膨胀的主因之一（单次实测：login 2.2G、chat-harness 639M）。
//
// chat-harness 是什么（2026-11-02 实测确认）：aih 自己的聊天 harness 目录，**没有按账号存会话**。
// 它默认与全局 codex 存储建链（.codex 下 thread_history_1.sqlite / sessions 等都是指向
// ~/.codex 的软链），删掉只删链接和 config.toml，会话 thread 仍在全局存储里。
// 只有「私有 store」——.codex/thread_history_1.sqlite 是真文件而不是软链——才装着别处没有的
// thread（历史遗留目录，如 acct_c016fd7eee0f64163068 的 102M 真文件），这种不按年龄回收。
//
// 规则：
//   1) 账号已删除 → 对应的 harness / 投影目录立即回收（不问年龄）；
//   2) 其余目录按「目录树内最新一次写入」超过保留天数回收，默认 10 天
//      （AIH_RUNTIME_RETENTION_DAYS 可覆盖）。只看顶层目录 mtime 会误杀活跃目录：
//      chat-harness/<scope> 顶层只在新增子目录时变，内部 .codex 天天在写；
//   3) 私有 thread store 的 harness 不按年龄回收（会话内容只在这里）；
//   4) 当前进程自己的 HOME（沙箱里跑 CLI 时）永远不在回收范围内。

const DEFAULT_RETENTION_DAYS = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

function resolveRetentionDays(env) {
  const days = Number((env || {}).AIH_RUNTIME_RETENTION_DAYS);
  return Number.isFinite(days) && days > 0 ? Math.floor(days) : DEFAULT_RETENTION_DAYS;
}

function listDirectories(fs, dirPath) {
  try {
    return fs.readdirSync(dirPath, { withFileTypes: true })
      .filter((entry) => entry && typeof entry.isDirectory === 'function' && entry.isDirectory())
      .map((entry) => entry.name);
  } catch (_error) {
    return [];
  }
}

// 目录树里最新一次写入的时间。顶层目录 mtime 只在直接子项增删时变，
// 活跃的 harness 内部一直写 .codex/**，顶层却可能停在十天前。
function latestMtimeMs(fs, pathImpl, dirPath) {
  let newest = 0;
  try { newest = Number(fs.statSync(dirPath).mtimeMs || 0); } catch (_error) { return 0; }
  const stack = [dirPath];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch (_error) { continue; }
    for (const entry of entries) {
      const entryPath = pathImpl.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { stack.push(entryPath); continue; }
      try {
        const mtime = Number(fs.statSync(entryPath).mtimeMs || 0);
        if (mtime > newest) newest = mtime;
      } catch (_error) {}
    }
  }
  return newest;
}

function sizeOf(fs, pathImpl, dirPath) {
  let total = 0;
  const stack = [dirPath];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch (_error) { continue; }
    for (const entry of entries) {
      const entryPath = pathImpl.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { stack.push(entryPath); continue; }
      try { total += Number(fs.statSync(entryPath).size) || 0; } catch (_error) {}
    }
  }
  return total;
}

function removeTree(fs, pathImpl, dirPath) {
  let entries = [];
  try { entries = fs.readdirSync(dirPath, { withFileTypes: true }); } catch (_error) { return; }
  for (const entry of entries) {
    const entryPath = pathImpl.join(dirPath, entry.name);
    try {
      if (entry.isSymbolicLink()) { fs.unlinkSync(entryPath); continue; }
      if (entry.isDirectory()) { removeTree(fs, pathImpl, entryPath); fs.rmdirSync(entryPath); continue; }
      fs.unlinkSync(entryPath);
    } catch (_error) { /* 单个文件失败不影响整体 */ }
  }
}

function removeDirectory(fs, pathImpl, dirPath, reason, report) {
  const bytes = sizeOf(fs, pathImpl, dirPath);
  removeTree(fs, pathImpl, dirPath);
  try { fs.rmdirSync(dirPath); } catch (_error) { return false; }
  report.removed.push({ path: dirPath, reason, bytes });
  report.freedBytes += bytes;
  return true;
}

/**
 * 执行一次保留期回收。
 *
 * @param {Object} options
 * @param {any} options.fs
 * @param {any} options.path
 * @param {string} options.aiHomeDir
 * @param {string[]} [options.activeAccountRefs] 现存账号 ref；缺省时不做孤儿回收
 * @param {string} [options.currentHome] 当前进程 HOME（受保护）
 * @param {number} [options.now]
 * @param {number} [options.keepDays]
 * @returns {{removed: Array<{path: string, reason: string, bytes: number}>, freedBytes: number, scanned: number}}
 */
function sweepRuntimeRetention(options = {}) {
  const fs = options.fs || nodeFs;
  const pathImpl = options.path || nodePath;
  const aiHomeDir = String(options.aiHomeDir || '').trim();
  const report = { removed: [], freedBytes: 0, scanned: 0 };
  if (!aiHomeDir) return report;
  const runRoot = pathImpl.join(aiHomeDir, 'run');
  const now = Number(options.now) || Date.now();
  const keepDays = Number(options.keepDays) > 0 ? Number(options.keepDays) : DEFAULT_RETENTION_DAYS;
  const cutoff = now - keepDays * DAY_MS;
  const currentHome = String(options.currentHome || '').trim();
  const activeRefs = Array.isArray(options.activeAccountRefs)
    ? new Set(options.activeAccountRefs.map((ref) => String(ref || '').trim()).filter(Boolean))
    : null;
  const isProtected = (dirPath) => Boolean(currentHome) && pathImpl.resolve(dirPath) === pathImpl.resolve(currentHome);
  const isStale = (dirPath) => latestMtimeMs(fs, pathImpl, dirPath) < cutoff;
  // 私有 thread store：.codex/thread_history_1.sqlite 是真文件（不是指向全局存储的软链），
  // 说明这个 harness 装着别处没有的 thread，不能按年龄删。
  const hasPrivateThreadStore = (dirPath) => {
    const storePath = pathImpl.join(dirPath, '.codex', 'thread_history_1.sqlite');
    let stat = null;
    try { stat = fs.lstatSync(storePath); } catch (_error) { return false; }
    return Boolean(stat) && !stat.isSymbolicLink() && Number(stat.size) > 0;
  };

  // 1) chat-harness：账号已删除的目录立即回收（可再生，但没有任何账号会用到了）
  const harnessRoot = pathImpl.join(runRoot, 'chat-harness');
  for (const name of listDirectories(fs, harnessRoot)) {
    const dirPath = pathImpl.join(harnessRoot, name);
    report.scanned += 1;
    if (isProtected(dirPath)) continue;
    const orphan = activeRefs !== null && name.startsWith('acct_') && !activeRefs.has(name);
    if (orphan) { removeDirectory(fs, pathImpl, dirPath, 'orphan-harness', report); continue; }
    if (hasPrivateThreadStore(dirPath)) continue;
    if (isStale(dirPath)) removeDirectory(fs, pathImpl, dirPath, 'stale-harness', report);
  }

  // 2) login：过期登录沙箱（每份都是完整伪 HOME，单份可达上百 MB）
  const loginRoot = pathImpl.join(runRoot, 'login');
  for (const provider of listDirectories(fs, loginRoot)) {
    const providerDir = pathImpl.join(loginRoot, provider);
    for (const authId of listDirectories(fs, providerDir)) {
      const dirPath = pathImpl.join(providerDir, authId);
      report.scanned += 1;
      if (isProtected(dirPath)) continue;
      if (isStale(dirPath)) removeDirectory(fs, pathImpl, dirPath, 'stale-login', report);
    }
  }

  // 3) verification：验证产物
  const verificationRoot = pathImpl.join(runRoot, 'verification');
  for (const name of listDirectories(fs, verificationRoot)) {
    const dirPath = pathImpl.join(verificationRoot, name);
    report.scanned += 1;
    if (isProtected(dirPath)) continue;
    if (isStale(dirPath)) removeDirectory(fs, pathImpl, dirPath, 'stale-verification', report);
  }

  return report;
}

module.exports = {
  DEFAULT_RETENTION_DAYS,
  latestMtimeMs,
  resolveRetentionDays,
  sweepRuntimeRetention
};
