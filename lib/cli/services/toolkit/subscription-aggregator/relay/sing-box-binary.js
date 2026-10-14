'use strict';

const nativeFs = require('node:fs');
const nativePath = require('node:path');
const { resolveProxyPoolAiHome } = require('../../proxy-pool/aih-home');

/**
 * 本机中转要用的 sing-box 内核从哪里来。
 *
 * 查找顺序（第一个可执行的胜出）：
 *   1. 显式注入的路径 / AIH_RELAY_SING_BOX_BIN
 *   2. ~/.ai_home/bin/sing-box —— AIH 的托管位置（历史版本把内核放在这里）
 *   3. PATH 里的 sing-box
 *   4. /opt/homebrew/bin、/usr/local/bin、/usr/bin 这些常见位置（POSIX）
 *
 * Windows 上发布包是 `sing-box.exe`（见 binaryNameCandidates），托管目录与 PATH 都按后缀找；
 * 系统目录那几条是 POSIX 专有，Windows 靠 PATH。
 *
 * 找不到就返回 null，调用方 fail-closed（不输出本地端口，节点照旧被跳过）。
 * **不自动下载**：内核是一个能执行任意代码的二进制，装不装由用户决定，AIH 不替他做这个决定。
 */

const MANAGED_BINARY_NAME = 'sing-box';
const COMMON_DIRECTORIES = Object.freeze(['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']);

/**
 * 可执行文件名候选。Windows 的发布包就叫 `sing-box.exe`（托管目录与 PATH 上都带后缀），
 * 其它平台没有后缀；`PATHEXT` 里显式列了别的后缀时也一并认（少见，但零成本）。
 * 少了这一步，Windows 上装在 PATH 里的 sing-box.exe 会被判成「没装内核」。
 */
function binaryNameCandidates(env = {}, platform = process.platform) {
  if (platform !== 'win32') return [MANAGED_BINARY_NAME];
  const names = [`${MANAGED_BINARY_NAME}.exe`];
  for (const extension of String(env.PATHEXT || '').split(';').map((item) => item.trim().toLowerCase())) {
    if (!extension.startsWith('.')) continue;
    const name = `${MANAGED_BINARY_NAME}${extension}`;
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
 * → { path, source } | null。source 用于在界面上说清内核是哪来的（托管 / PATH / 系统目录）。
 */
function resolveSingBoxBinary(options = {}) {
  const fsImpl = options.fs || nativeFs;
  const pathImpl = options.path || nativePath;
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const names = binaryNameCandidates(env, platform);
  const explicit = String(options.binaryPath || env.AIH_RELAY_SING_BOX_BIN || '').trim();
  if (explicit) return isExecutableFile(fsImpl, explicit) ? { path: explicit, source: 'explicit' } : null;
  const aiHomeDir = resolveProxyPoolAiHome({ aiHomeDir: options.aiHomeDir, env, platform: options.platform, os: options.os, path: pathImpl });
  for (const name of names) {
    const managed = pathImpl.join(aiHomeDir, 'bin', name);
    if (isExecutableFile(fsImpl, managed)) return { path: managed, source: 'managed' };
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

/** `sing-box version` 的第一行形如 `sing-box version 1.13.19`；解析不出来返回 ''。 */
function parseSingBoxVersion(stdout) {
  const match = /sing-box\s+version\s+v?(\d+\.\d+(?:\.\d+)?)/i.exec(String(stdout || ''));
  return match ? match[1] : '';
}

module.exports = {
  COMMON_DIRECTORIES,
  MANAGED_BINARY_NAME,
  binaryNameCandidates,
  findOnPath,
  isExecutableFile,
  parseSingBoxVersion,
  resolveSingBoxBinary
};
