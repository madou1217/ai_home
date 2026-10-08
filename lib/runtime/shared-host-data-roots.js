'use strict';

const nodeFs = require('node:fs');
const nodePath = require('node:path');

const { getProviderSharedHostDataRoots } = require('./provider-storage-policy');

// 把账号投影（伪 HOME）里声明的桌面 App 数据根整体链接到宿主同名目录（声明见
// provider-storage-policy.js 的 sharedHostDataRoots）：会话与数据库只有宿主一份。
//
// 与可再生的缓存不同，投影里已有的真实数据不能丢：
//   - 投影里没有，或只是空目录 → 建链接；
//   - 宿主没有、投影里有 → 整个移给宿主（谈不上合并）再建链接；
//   - 两边都有真实数据 → 不合并、不丢弃，记为 unresolved，由调用方拒绝启动。

function samePath(pathImpl, left, right) {
  return pathImpl.resolve(left) === pathImpl.resolve(right);
}

function lstatOrNull(fs, filePath) {
  try { return fs.lstatSync(filePath); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function isEmptyDirectory(fs, filePath) {
  return fs.readdirSync(filePath).length === 0;
}

function linkOne(fs, pathImpl, platform, projectionPath, hostTarget) {
  const info = lstatOrNull(fs, projectionPath);
  if (info && info.isSymbolicLink()) {
    const target = pathImpl.resolve(pathImpl.dirname(projectionPath), fs.readlinkSync(projectionPath));
    if (samePath(pathImpl, target, hostTarget)) return 'unchanged';
    return 'unresolved';
  }
  const hostInfo = lstatOrNull(fs, hostTarget);
  let outcome = 'linked';
  if (info && !info.isDirectory()) return 'unresolved';
  if (info && !isEmptyDirectory(fs, projectionPath)) {
    if (hostInfo) return 'unresolved';
    fs.mkdirSync(pathImpl.dirname(hostTarget), { recursive: true });
    fs.renameSync(projectionPath, hostTarget);
    outcome = 'adopted';
  } else {
    if (info) fs.rmdirSync(projectionPath);
    // 投影与宿主都没有：不在宿主凭空建目录。
    if (!hostInfo) return 'skipped';
  }
  fs.mkdirSync(pathImpl.dirname(projectionPath), { recursive: true });
  fs.symlinkSync(hostTarget, projectionPath, platform === 'win32' ? 'junction' : 'dir');
  return outcome;
}

/**
 * @returns {{ linked: string[], adopted: string[], unchanged: string[], unresolved: string[], failed: Array<{ path: string, error: string }> }}
 */
function linkSharedHostDataRoots(options = {}) {
  const fs = options.fs || nodeFs;
  const pathImpl = options.path || nodePath;
  const platform = options.platform || process.platform;
  const projectionRoot = String(options.projectionRoot || '').trim();
  const hostHomeDir = String(options.hostHomeDir || '').trim();
  const result = { linked: [], adopted: [], unchanged: [], unresolved: [], failed: [] };
  if (!projectionRoot || !hostHomeDir || samePath(pathImpl, projectionRoot, hostHomeDir)) return result;

  for (const entry of getProviderSharedHostDataRoots(options.provider)) {
    const relative = pathImpl.join(...entry.projection);
    try {
      const outcome = linkOne(
        fs, pathImpl, platform,
        pathImpl.join(projectionRoot, ...entry.projection),
        pathImpl.join(hostHomeDir, ...entry.host)
      );
      if (result[outcome]) result[outcome].push(relative);
    } catch (error) {
      result.failed.push({ path: relative, error: String((error && (error.code || error.message)) || error) });
    }
  }
  return result;
}

function hasSharedHostDataRoots(provider) {
  return getProviderSharedHostDataRoots(provider).length > 0;
}

module.exports = {
  hasSharedHostDataRoots,
  linkSharedHostDataRoots
};
