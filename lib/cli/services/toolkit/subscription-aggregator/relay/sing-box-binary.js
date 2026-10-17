'use strict';

const { COMMON_DIRECTORIES, binaryNameCandidates: nameCandidates, findOnPath, isExecutableFile, resolveKernelBinary } = require('./kernel-binary');

/**
 * 本机中转要用的 sing-box 内核从哪里来。查找顺序与「不自动下载」的原则见 kernel-binary.js。
 */

const MANAGED_BINARY_NAME = 'sing-box';

/** sing-box 的可执行文件名候选（Windows 是 `sing-box.exe`）。 */
function binaryNameCandidates(env = {}, platform = process.platform) {
  return nameCandidates(MANAGED_BINARY_NAME, env, platform);
}

/** → { path, source } | null。source 用于在界面上说清内核是哪来的（托管 / PATH / 系统目录）。 */
function resolveSingBoxBinary(options = {}) {
  return resolveKernelBinary({ baseName: MANAGED_BINARY_NAME, envField: 'singBoxBin' }, options);
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
