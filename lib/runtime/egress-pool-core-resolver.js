'use strict';

// 出口池的 mihomo 内核定位。AIH 不下载内核：优先用自己托管的一份
// （<aiHome>/tools/mihomo），其次探测用户已装的代理客户端自带的 mihomo
// （Clash Verge / Mihomo Party / ClashX Meta …），都没有就返回空让调用方
// fail-closed —— 出口池是增强能力，缺内核不该影响其它 provider。
//
// 只做定位，不启动、不校验版本（版本校验交给真正 spawn 的那一步）。

const nodeFs = require('node:fs');
const nodePath = require('node:path');

// AIH 托管位置（用户可手动放一份，AIH 自己不下载）。
const MANAGED_RELATIVE_PATH = Object.freeze(['tools', 'mihomo']);

// 用户已装客户端自带的内核：macOS 为主（本项目出口绑定只支持 macos，
// 见 zcode-egress-resolver 的 SUPPORTED_PLATFORM）。
const CLIENT_BUNDLED_PATHS = Object.freeze([
  '/Applications/Clash Verge.app/Contents/MacOS/verge-mihomo-alpha',
  '/Applications/Clash Verge.app/Contents/MacOS/verge-mihomo',
  '/Applications/Mihomo Party.app/Contents/Resources/resources/mihomo',
  '/Applications/ClashX Meta.app/Contents/Resources/mihomo',
  '/Applications/ClashX Pro.app/Contents/Resources/mihomo'
]);

// Windows 上用户已装客户端自带的内核（Clash Verge 安装到 Program Files，内核是真实的 exe）。
const WINDOWS_CLIENT_BUNDLED_PATHS = Object.freeze([
  'C:\\Program Files\\Clash Verge\\verge-mihomo-alpha.exe',
  'C:\\Program Files\\Clash Verge\\verge-mihomo.exe',
  'C:\\Program Files\\Mihomo Party\\resources\\sidecar\\mihomo.exe'
]);

// PATH 上的常见名字（brew install mihomo 等）。
const PATH_COMMAND_NAMES = Object.freeze(['mihomo', 'clash-meta', 'clash']);

// Windows 不能执行无扩展名的文件（spawn 报 ENOENT，2026-10-19 真机实测）：托管位置与 PATH 查找都要带 .exe。
function executableName(name, platform) {
  return platform === 'win32' ? `${name}.exe` : name;
}

function isExecutableFile(fs, filePath) {
  try {
    const stat = fs.statSync(filePath);
    // 0 字节的占位文件（Clash Verge 的 verge-mihomo 就是这种）不能当内核。
    return stat.isFile() && stat.size > 0;
  } catch (_error) {
    return false;
  }
}

/** 在 PATH 里按名字找可执行文件；找不到返回 ''。 */
function findOnPath(fs, path, env, name) {
  const rawPath = String((env && env.PATH) || '');
  for (const dir of rawPath.split(path.delimiter || nodePath.delimiter)) {
    const trimmed = String(dir || '').trim();
    if (!trimmed) continue;
    const candidate = path.join(trimmed, name);
    if (isExecutableFile(fs, candidate)) return candidate;
  }
  return '';
}

/**
 * 定位 mihomo 内核。
 *
 * @returns {{ path: string, source: 'managed'|'client'|'path' }|null} null = 没找到
 */
function resolveMihomoCorePath(options = {}) {
  const fs = options.fs || nodeFs;
  const path = options.path || nodePath;
  const env = options.env || process.env || {};
  const aiHomeDir = String(options.aiHomeDir || '').trim();
  const platform = options.platform || process.platform;

  // 托管位置就是唯一的显式覆盖入口：想换内核就把它放到 <aiHome>/tools/mihomo。
  // 不提供环境变量覆盖（AGENTS.md：禁止新增 AIH_* 环境变量）。
  if (aiHomeDir) {
    const relative = MANAGED_RELATIVE_PATH.slice();
    relative[relative.length - 1] = executableName(relative[relative.length - 1], platform);
    const managed = path.join(aiHomeDir, ...relative);
    if (isExecutableFile(fs, managed)) return { path: managed, source: 'managed' };
  }

  for (const candidate of (platform === 'win32' ? WINDOWS_CLIENT_BUNDLED_PATHS : CLIENT_BUNDLED_PATHS)) {
    if (isExecutableFile(fs, candidate)) return { path: candidate, source: 'client' };
  }

  for (const name of PATH_COMMAND_NAMES) {
    const found = findOnPath(fs, path, env, executableName(name, platform));
    if (found) return { path: found, source: 'path' };
  }

  return null;
}

module.exports = {
  CLIENT_BUNDLED_PATHS,
  MANAGED_RELATIVE_PATH,
  PATH_COMMAND_NAMES,
  WINDOWS_CLIENT_BUNDLED_PATHS,
  isExecutableFile,
  resolveMihomoCorePath
};
