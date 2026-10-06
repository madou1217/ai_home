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

function linkOne(fs, pathImpl, platform, projectionPath, hostTarget) {
  fs.mkdirSync(hostTarget, { recursive: true });
  let info = null;
  try { info = fs.lstatSync(projectionPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (info && info.isSymbolicLink()) {
    if (samePath(pathImpl, readLinkTarget(fs, pathImpl, projectionPath), hostTarget)) return 'unchanged';
    fs.unlinkSync(projectionPath);
  } else if (info) {
    // rmSync 递归删除不跟随链接：嵌套在缓存副本里的链接只删链接本身。
    fs.rmSync(projectionPath, { recursive: true, force: true });
  }
  fs.mkdirSync(pathImpl.dirname(projectionPath), { recursive: true });
  fs.symlinkSync(hostTarget, projectionPath, platform === 'win32' ? 'junction' : 'dir');
  return info && !info.isSymbolicLink() ? 'replaced' : 'linked';
}

/**
 * @returns {{ linked: string[], replaced: string[], failed: Array<{ path: string, error: string }> }}
 */
function linkSharedHostCaches(options = {}) {
  const fs = options.fs || nodeFs;
  const pathImpl = options.path || nodePath;
  const platform = options.platform || process.platform;
  const projectionRoot = String(options.projectionRoot || '').trim();
  const hostHomeDir = String(options.hostHomeDir || '').trim();
  const result = { linked: [], replaced: [], failed: [] };
  if (!projectionRoot || !hostHomeDir || samePath(pathImpl, projectionRoot, hostHomeDir)) return result;

  for (const entry of getProviderSharedHostCaches(options.provider, platform)) {
    const relative = pathImpl.join(...entry.projection);
    const projectionPath = pathImpl.join(projectionRoot, ...entry.projection);
    const hostTarget = pathImpl.join(hostHomeDir, ...entry.host);
    try {
      const outcome = linkOne(fs, pathImpl, platform, projectionPath, hostTarget);
      if (outcome === 'linked') result.linked.push(relative);
      if (outcome === 'replaced') result.replaced.push(relative);
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
