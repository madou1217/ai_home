'use strict';

// 判定「aih 实际会启动的那个二进制」属于哪个安装渠道。
//
// 这是整套自动升级里最关键的一环。反例是实测出来的，不是假想：本机 `which -a opencode`
// 同时存在 ~/.opencode/bin、~/.bun/bin、~/Library/pnpm/bin 三份，而 `npm ls -g` 里还装着
// opencode-ai。若按「有 npm 包就用 npm 升」的直觉行事，会再造一份，PATH 顺序决定谁赢，
// 于是出现最恶劣的形态：升级「成功」、回滚也「成功」，实际在跑的仍是坏的那份，监控全绿。
//
// 因此本模块只认 realpath，不信包管理器的自述。
//
// 渠道能力差异（实测 https://chatgpt.com/codex/install.sh）：
//   standalone_release —— 版本化 releases/ 目录 + current 符号链接原子切换。
//     升级写新目录、只切指针，从不 unlink 运行中的 exe → Windows 上结构性免疫 npm 那种 EPERM。
//     回滚复用本地已有的 release 目录，跳过整包下载；但仍需联网解析 assets（见下方能力表注释）。
//   npm_global —— 原地覆盖，能钉版本因而可回滚，但会 unlink 运行中的文件（Windows EPERM 来源）。
//   vendor_selfupdate —— provider 自带更新器（如 claude 的 versions/ 布局）。
//     aih 去 npm 装会造出与自更新器竞争 PATH 的第二份，正确动作是让路并上报，不是接管。

const nodeFs = require('node:fs');
const nodePath = require('node:path');

const { WRAPPER_MARKER } = require('../codex-cli-hook');

// aih 给 codex 写的入口（~/.local/bin/codex）是一段 shell/ps1 垫片，不是符号链接：
//   #!/bin/sh
//   # aih-codex-cli-hook-alias
//   exec '/Users/…/.codex/packages/standalone/current/bin/codex' "$@"
// realpath 追不进 exec，实测会让 codex 落进 unknown —— 而 codex 恰恰是最需要判对的一个。
// 只有确认带 aih 标记时才解析，绝不去猜别人的脚本。alias 标记以 WRAPPER_MARKER 为前缀，
// 因此一个判断同时覆盖两种垫片。
const SHIM_MAX_BYTES = 4096;
const QUOTED_PATH = /['"]([^'"\n]+)['"]/g;

function followAihShim(fsImpl, target) {
  try {
    const stat = fsImpl.statSync(target);
    if (!stat.isFile() || stat.size > SHIM_MAX_BYTES) return '';
    const text = fsImpl.readFileSync(target, 'utf8');
    if (!text.includes(WRAPPER_MARKER)) return '';
    for (const match of text.matchAll(QUOTED_PATH)) {
      const candidate = match[1];
      if (candidate && candidate !== target && fsImpl.existsSync(candidate)) return candidate;
    }
  } catch (_error) { /* 垫片解析失败就当它不是垫片 */ }
  return '';
}

const CHANNELS = Object.freeze({
  STANDALONE_RELEASE: 'standalone_release',
  NPM_GLOBAL: 'npm_global',
  VENDOR_SELFUPDATE: 'vendor_selfupdate',
  HOMEBREW: 'homebrew',
  UNKNOWN: 'unknown'
});

// pinnable：能否安装到指定版本（回滚的前提）。
// rollbackReusesLocalRelease：回滚时能否复用本地已有的 release 目录，从而跳过整包下载。
//   实测 install.sh 的执行顺序是 resolve_release(1127) → release_dir_is_complete(1156)
//   → update_current_link(1185)：**解析 assets 总是要联网**，跳过的只是下载。
//   所以这里表达的是「快」，不是「离线」——任何调用方都不得据此假设断网可回滚。
const CHANNEL_CAPABILITIES = Object.freeze({
  [CHANNELS.STANDALONE_RELEASE]: { pinnable: true, rollbackReusesLocalRelease: true },
  [CHANNELS.NPM_GLOBAL]: { pinnable: true, rollbackReusesLocalRelease: false },
  [CHANNELS.VENDOR_SELFUPDATE]: { pinnable: false, rollbackReusesLocalRelease: false },
  [CHANNELS.HOMEBREW]: { pinnable: false, rollbackReusesLocalRelease: false },
  [CHANNELS.UNKNOWN]: { pinnable: false, rollbackReusesLocalRelease: false }
});

function normalizeString(value) {
  return String(value == null ? '' : value).trim();
}

function safeRealpath(fsImpl, target) {
  const value = normalizeString(target);
  if (!value) return '';
  try {
    return fsImpl.realpathSync(value);
  } catch (_error) {
    return value;
  }
}

// 目录包含判定必须按路径分隔符边界比较，否则 /a/bc 会被 /a/b 误判为子路径。
function isInsideDir(pathImpl, dir, target) {
  const root = normalizeString(dir);
  const child = normalizeString(target);
  if (!root || !child) return false;
  const relative = pathImpl.relative(root, child);
  if (!relative) return true;
  return !relative.startsWith('..') && !pathImpl.isAbsolute(relative);
}

function detectCliChannel(input = {}) {
  const fsImpl = input.fs || nodeFs;
  const pathImpl = input.path || nodePath;
  const resolvedPath = normalizeString(input.resolvedPath);
  const evidence = [];

  if (!resolvedPath) {
    return {
      channel: CHANNELS.UNKNOWN,
      resolvedPath: '',
      ownerPath: '',
      pinnable: false,
      rollbackReusesLocalRelease: false,
      shadowedNpmInstall: false,
      evidence: ['cli_not_resolved']
    };
  }

  // aih 自己给 codex 写的 shim（~/.local/bin/codex）会 exec 到 standalone/current，
  // 所以必须解析到真身再判渠道，否则每个 provider 都会落进 unknown。
  let ownerPath = safeRealpath(fsImpl, resolvedPath);
  if (ownerPath !== resolvedPath) evidence.push('resolved_through_link');
  const shimTarget = followAihShim(fsImpl, ownerPath);
  if (shimTarget) {
    ownerPath = safeRealpath(fsImpl, shimTarget);
    evidence.push('resolved_through_aih_shim');
  }

  let channel = CHANNELS.UNKNOWN;
  // 根目录也必须 realpath 后再比：二进制侧已经解析过，两边不对齐就永远匹配不上。
  // 这不只是测试环境的问题（macOS 的 /var → /private/var），用户的 ~/.codex、
  // Homebrew 前缀本身就可能是符号链接。
  const realRoot = (value) => safeRealpath(fsImpl, value);
  const standaloneRoots = (Array.isArray(input.standaloneRoots) ? input.standaloneRoots : [])
    .map(normalizeString).filter(Boolean).map(realRoot);
  const npmGlobalRoot = realRoot(input.npmGlobalRoot);
  const vendorRoots = (Array.isArray(input.vendorSelfUpdateRoots) ? input.vendorSelfUpdateRoots : [])
    .map(normalizeString).filter(Boolean).map(realRoot);
  const homebrewRoots = (Array.isArray(input.homebrewRoots) ? input.homebrewRoots : [])
    .map(normalizeString).filter(Boolean).map(realRoot);

  if (standaloneRoots.some((root) => isInsideDir(pathImpl, root, ownerPath))) {
    channel = CHANNELS.STANDALONE_RELEASE;
    evidence.push('under_standalone_releases');
  } else if (npmGlobalRoot && isInsideDir(pathImpl, npmGlobalRoot, ownerPath)) {
    channel = CHANNELS.NPM_GLOBAL;
    evidence.push('under_npm_global_root');
  } else if (vendorRoots.some((root) => isInsideDir(pathImpl, root, ownerPath))) {
    channel = CHANNELS.VENDOR_SELFUPDATE;
    evidence.push('under_vendor_selfupdate_root');
  } else if (homebrewRoots.some((root) => isInsideDir(pathImpl, root, ownerPath))) {
    channel = CHANNELS.HOMEBREW;
    evidence.push('under_homebrew_root');
  } else {
    evidence.push('no_known_root_matched');
  }

  // 影子安装：npm 里装着这个包，但真正会被启动的不是它。此时用 npm 去「升级」只会再造一份，
  // 且升级/回滚都会对着看不见的那份空转 —— 必须显式标出来，让状态面能直接暴露。
  // 必须实地确认那个 npm 包目录存在：只按路径拼接判断会把「npm 里根本没装」也标成影子，
  // 实测会让 codex/claude 全部误报，状态面一旦开始喊狼来了就没人看了。
  const npmPackageDirInput = normalizeString(input.npmPackageDir);
  const npmPackageExists = Boolean(npmPackageDirInput && fsImpl.existsSync(npmPackageDirInput));
  const npmPackageDir = npmPackageExists ? realRoot(npmPackageDirInput) : '';
  const shadowedNpmInstall = Boolean(
    npmPackageDir
    && channel !== CHANNELS.NPM_GLOBAL
    && isInsideDir(pathImpl, npmGlobalRoot || npmPackageDir, npmPackageDir)
  );
  if (shadowedNpmInstall) evidence.push('npm_install_shadowed');

  const capabilities = CHANNEL_CAPABILITIES[channel] || CHANNEL_CAPABILITIES[CHANNELS.UNKNOWN];
  return {
    channel,
    resolvedPath,
    ownerPath,
    pinnable: capabilities.pinnable,
    rollbackReusesLocalRelease: capabilities.rollbackReusesLocalRelease,
    shadowedNpmInstall,
    evidence
  };
}

module.exports = { CHANNELS, CHANNEL_CAPABILITIES, detectCliChannel };
