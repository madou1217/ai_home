'use strict';

const nodeFs = require('node:fs');
const nodePath = require('node:path');

const { getProviderSharedHostCaches } = require('./provider-storage-policy');

// 把账号投影（伪 HOME）里声明为"宿主共享缓存"的路径变成指向宿主真实路径的链接，
// 让每个账号不再各自下载一套工具链 / 应用更新包（声明见 provider-storage-policy.js
// 的 sharedHostCaches）。
//
// 投影里已有的真实目录是缓存副本：直接丢弃后建链，不合并进宿主——缓存可再生，
// 合并只会把每个账号的旧版本搬进宿主。单项失败只记录、不抛出：缓存链接失败不能
// 挡住应用启动，最坏情况就是这一项照旧各存一份。

function samePath(pathImpl, left, right) {
  return pathImpl.resolve(left) === pathImpl.resolve(right);
}

function readLinkTarget(fs, pathImpl, linkPath) {
  return pathImpl.resolve(pathImpl.dirname(linkPath), fs.readlinkSync(linkPath));
}

function existsByLstat(fs, filePath) {
  try { fs.lstatSync(filePath); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function realPathOrEmpty(fs, filePath) {
  try { return fs.realpathSync(filePath); } catch (_error) { return ''; }
}

function linkOne(fs, pathImpl, platform, projectionPath, hostTarget) {
  // 投影路径经由上层链接（比如整体链到宿主的数据根）已经就是宿主这一份时，它的
  // "真实目录"就是宿主数据本身——绝不能当成副本删掉。
  const projectionReal = realPathOrEmpty(fs, projectionPath);
  if (projectionReal && projectionReal === realPathOrEmpty(fs, hostTarget)) return 'unchanged';
  let info = null;
  try { info = fs.lstatSync(projectionPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (info && info.isSymbolicLink()
    && samePath(pathImpl, readLinkTarget(fs, pathImpl, projectionPath), hostTarget)) return 'unchanged';
  const realCopy = Boolean(info && !info.isSymbolicLink());
  let outcome = 'linked';
  if (!existsByLstat(fs, hostTarget)) {
    // 宿主还没有这项缓存：投影里也没有就什么都不做，不在宿主凭空建空目录；
    // 投影里有真实副本就整体移给宿主（宿主无同名目录，谈不上合并），省掉重新下载。
    if (!realCopy) return 'skipped';
    fs.mkdirSync(pathImpl.dirname(hostTarget), { recursive: true });
    fs.renameSync(projectionPath, hostTarget);
    outcome = 'adopted';
  } else if (realCopy) {
    // 宿主已有：投影副本直接丢弃，不合并。rmSync 递归删除不跟随链接。
    fs.rmSync(projectionPath, { recursive: true, force: true });
    outcome = 'replaced';
  } else if (info) {
    fs.unlinkSync(projectionPath);
  }
  fs.mkdirSync(pathImpl.dirname(projectionPath), { recursive: true });
  fs.symlinkSync(hostTarget, projectionPath, platform === 'win32' ? 'junction' : 'dir');
  return outcome;
}

/**
 * linked：新建链接；replaced：丢弃投影副本后建链；adopted：宿主原本没有，投影副本移给宿主。
 * @returns {{ linked: string[], replaced: string[], adopted: string[], failed: Array<{ path: string, error: string }> }}
 */
function linkSharedHostCaches(options = {}) {
  const fs = options.fs || nodeFs;
  const pathImpl = options.path || nodePath;
  const platform = options.platform || process.platform;
  const projectionRoot = String(options.projectionRoot || '').trim();
  const hostHomeDir = String(options.hostHomeDir || '').trim();
  const result = { linked: [], replaced: [], adopted: [], failed: [] };
  if (!projectionRoot || !hostHomeDir || samePath(pathImpl, projectionRoot, hostHomeDir)) return result;

  for (const entry of getProviderSharedHostCaches(options.provider, platform)) {
    const relative = pathImpl.join(...entry.projection);
    const projectionPath = pathImpl.join(projectionRoot, ...entry.projection);
    const hostTarget = pathImpl.join(hostHomeDir, ...entry.host);
    try {
      const outcome = linkOne(fs, pathImpl, platform, projectionPath, hostTarget);
      if (result[outcome]) result[outcome].push(relative);
    } catch (error) {
      result.failed.push({ path: relative, error: String((error && (error.code || error.message)) || error) });
    }
  }
  return result;
}

/** 投影内的相对路径段是否落在某个共享缓存上（含其内部），供投影资源校验跳过。 */
function isSharedHostCacheSegments(provider, segments, platform = process.platform) {
  const normalized = (Array.isArray(segments) ? segments : []).map((segment) => String(segment));
  return getProviderSharedHostCaches(provider, platform).some((entry) => (
    entry.projection.length <= normalized.length
    && entry.projection.every((segment, index) => segment === normalized[index])
  ));
}

module.exports = {
  isSharedHostCacheSegments,
  linkSharedHostCaches
};
