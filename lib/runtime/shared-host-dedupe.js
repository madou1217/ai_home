'use strict';

const nodeCrypto = require('node:crypto');
const nodeFs = require('node:fs');
const nodePath = require('node:path');

const { getProviderSharedHostDedupe } = require('./provider-storage-policy');

// 把账号投影里与宿主同版本的应用解压内容逐文件替换成指向宿主文件的硬链接
// （声明见 provider-storage-policy.js 的 sharedHostDedupe）。每个账号仍有自己的目录树，
// 应用升级时各自重新解压、互不干扰；只是同版本的文件在磁盘上只存一份。
//
// 只在两边版本戳完全相同时去重；已共享 inode 的文件直接跳过（所以重复启动几乎零成本）；
// 其余先比大小再比内容哈希，完全一致才以"同目录临时硬链接 + rename"原子替换。
// 单个文件失败只计数、不抛出；不写任何标记文件。
// 调用方必须保证该账号的实例此刻没有在运行（桌面启动在 spawn 前调用）。

function readStamp(fs, file) {
  try { return fs.readFileSync(file, 'utf8').trim(); } catch (_error) { return ''; }
}

function hashFile(fs, crypto, file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function dedupeTree(ctx, accountDir, hostDir, stats) {
  const { fs, pathImpl } = ctx;
  let entries;
  try { entries = fs.readdirSync(accountDir, { withFileTypes: true }); } catch (_error) { return; }
  for (const entry of entries) {
    const accountPath = pathImpl.join(accountDir, entry.name);
    const hostPath = pathImpl.join(hostDir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) { dedupeTree(ctx, accountPath, hostPath, stats); continue; }
    if (!entry.isFile()) continue;
    try {
      const accountStat = fs.statSync(accountPath, { bigint: true });
      let hostStat;
      try { hostStat = fs.statSync(hostPath, { bigint: true }); } catch (_error) { continue; }
      if (!hostStat.isFile() || hostStat.size !== accountStat.size) continue;
      if (hostStat.dev === accountStat.dev && hostStat.ino === accountStat.ino) { stats.alreadyShared += 1; continue; }
      if (hashFile(fs, ctx.crypto, accountPath) !== hashFile(fs, ctx.crypto, hostPath)) continue;
      const tempPath = `${accountPath}.aih-dedupe-${process.pid}`;
      try {
        fs.linkSync(hostPath, tempPath);
        fs.renameSync(tempPath, accountPath);
      } catch (error) {
        try { fs.rmSync(tempPath, { force: true }); } catch (_cleanupError) {}
        throw error;
      }
      stats.linked += 1;
      stats.bytes += Number(accountStat.size);
    } catch (_error) {
      stats.failed += 1;
    }
  }
}

/**
 * @returns {{ linked: number, alreadyShared: number, failed: number, bytes: number, skipped: string[] }}
 */
function dedupeSharedHostFiles(options = {}) {
  const fs = options.fs || nodeFs;
  const pathImpl = options.path || nodePath;
  const crypto = options.crypto || nodeCrypto;
  const platform = options.platform || process.platform;
  const projectionRoot = String(options.projectionRoot || '').trim();
  const hostHomeDir = String(options.hostHomeDir || '').trim();
  const stats = { linked: 0, alreadyShared: 0, failed: 0, bytes: 0, skipped: [] };
  if (!projectionRoot || !hostHomeDir) return stats;

  for (const entry of getProviderSharedHostDedupe(options.provider, platform)) {
    const relative = pathImpl.join(...entry.projection);
    const accountDir = pathImpl.join(projectionRoot, ...entry.projection);
    const hostDir = pathImpl.join(hostHomeDir, ...entry.host);
    const accountStamp = readStamp(fs, pathImpl.join(accountDir, entry.stampFile));
    const hostStamp = readStamp(fs, pathImpl.join(hostDir, entry.stampFile));
    // 版本不同（或任一侧未解压完成）时不碰：应用会在下次启动时自行重新解压。
    if (!accountStamp || accountStamp !== hostStamp) { stats.skipped.push(relative); continue; }
    dedupeTree({ fs, pathImpl, crypto }, accountDir, hostDir, stats);
  }
  return stats;
}

module.exports = {
  dedupeSharedHostFiles
};
