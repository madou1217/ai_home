'use strict';

const nativeFs = require('node:fs');
const nativePath = require('node:path');
const { resolveProxyPoolAiHome } = require('../../proxy-pool/aih-home');
const { readRelaySetting } = require('../../../../../server/relay-settings');

/**
 * 本机中转的内核可执行文件查找（sing-box / mihomo 共用）。
 *
 * 查找顺序（第一个可执行的胜出）：
 *   1. 显式注入的路径 / AIH_RELAY_SETTINGS 里的 singBoxBin / mihomoBin
 *   2. ~/.ai_home/bin/<名字> —— AIH 的托管位置
 *   3. PATH
 *   4. /opt/homebrew/bin、/usr/local/bin、/usr/bin 这些常见位置（POSIX）
 *
 * Windows 上发布包带 `.exe`，托管目录与 PATH 都按后缀找；系统目录那几条是 POSIX 专有，Windows 靠 PATH。
 * 找不到就返回 null，调用方 fail-closed（不输出本地入口，节点照旧被跳过）。
 * **不自动下载**：内核是能执行任意代码的二进制，装不装由用户决定，AIH 不替他做这个决定。
 */

const COMMON_DIRECTORIES = Object.freeze(['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']);

/**
 * 可执行文件名候选。Windows 的发布包带 `.exe`；`PATHEXT` 里显式列了别的后缀时也一并认。
 * 少了这一步，Windows 上装在 PATH 里的内核会被判成「没装」。
 */
function binaryNameCandidates(baseName, env = {}, platform = process.platform) {
  if (platform !== 'win32') return [baseName];
  const names = [`${baseName}.exe`];
  for (const extension of String(env.PATHEXT || '').split(';').map((item) => item.trim().toLowerCase())) {
    if (!extension.startsWith('.')) continue;
    const name = `${baseName}${extension}`;
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

function isExecutableFile(fsImpl, filePath) {
  if (!filePath) return false;
  try {
    if (!fsImpl.statSync(filePath).isFile()) return false;
    fsImpl.accessSync(filePath, fsImpl.constants?.X_OK || nativeFs.constants.X_OK);
    return true;
  } catch (_error) {
    return false;
  }
}

function findOnPath(fsImpl, pathImpl, env, names) {
  for (const directory of String(env.PATH || '').split(pathImpl.delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = pathImpl.join(directory, name);
      if (isExecutableFile(fsImpl, candidate)) return candidate;
    }
  }
  return '';
}

/**
 * → { path, source } | null。source 用于在界面上说清内核是哪来的（显式 / 托管 / PATH / 系统目录）。
 * aliases 是同一种内核的其它二进制名（例如 mihomo 的 verge-mihomo-alpha、clash-meta）。
 */
function resolveKernelBinary({ baseName, aliases = [], envField, managedName = '' }, options = {}) {
  const fsImpl = options.fs || nativeFs;
  const pathImpl = options.path || nativePath;
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const explicit = String(options.binaryPath || readRelaySetting(env, envField) || '').trim();
  if (explicit) return isExecutableFile(fsImpl, explicit) ? { path: explicit, source: 'explicit' } : null;
  const names = [baseName, ...aliases].flatMap((name) => binaryNameCandidates(name, env, platform));
  const aiHomeDir = resolveProxyPoolAiHome({
    aiHomeDir: options.aiHomeDir, env, platform: options.platform, os: options.os, path: pathImpl
  });
  const managed = [managedName || baseName, ...aliases].flatMap((name) => binaryNameCandidates(name, env, platform));
  for (const name of managed) {
    const candidate = pathImpl.join(aiHomeDir, 'bin', name);
    if (isExecutableFile(fsImpl, candidate)) return { path: candidate, source: 'managed' };
  }
  const onPath = findOnPath(fsImpl, pathImpl, env, names);
  if (onPath) return { path: onPath, source: 'path' };
  for (const directory of COMMON_DIRECTORIES) {
    for (const name of names) {
      const candidate = pathImpl.join(directory, name);
      if (isExecutableFile(fsImpl, candidate)) return { path: candidate, source: 'system' };
    }
  }
  return null;
}

module.exports = {
  COMMON_DIRECTORIES,
  binaryNameCandidates,
  findOnPath,
  isExecutableFile,
  resolveKernelBinary
};
