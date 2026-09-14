'use strict';

// 各安装渠道的根目录探测。detectCliChannel 只认 realpath，本模块负责告诉它「哪些目录算哪条渠道」。
//
// 本机实测（2026-09-14，macOS）是这套规则的依据：
//   codex     ~/.local/bin/codex 是 aih 的 shim → exec 到 ~/.codex/packages/standalone/current
//   gemini    /opt/homebrew/bin/gemini      → /opt/homebrew/lib/node_modules/@google/gemini-cli/...
//   kimi      ~/.nvm/versions/node/v22/bin/kimi → /opt/homebrew/lib/node_modules/@moonshot-ai/...
//   claude    ~/.local/bin/claude           → ~/.local/share/claude/versions/2.1.267
//   opencode  ~/.opencode/bin/opencode（另有 .bun / pnpm / homebrew 三份影子）
//
// 两个由此确定的设计：
//
// 1. npmGlobalRoot 只取**我们真会调用的那个 npm** 的 root（`npm root -g`）。
//    机器上同时存在 homebrew node 与 nvm node 是常态，二者的全局目录不同。
//    若为了「多覆盖一点」把多个候选根都算成 npm 渠道，就会出现：判定说归 npm 管，
//    实际 `npm i -g` 装进了另一个前缀 —— 正是 upgrade-channel 开头警告的影子安装。
//    不在这个 root 下的二进制一律不认作 npm 渠道，于是 policy 端判 not pinnable 而不动手。
//    覆盖率换正确性，这笔交易必须这么做。
//
// 2. 渠道匹配顺序是 standalone → npm → vendor → homebrew（在 detectCliChannel 里）。
//    homebrew 前缀下的 lib/node_modules 同时命中 homebrew 与 npm 两个根，
//    而它确实是 npm 装的（gemini/kimi 即是），npm 先判正好给出正确答案。

const nodeFs = require('node:fs');
const nodePath = require('node:path');
const { spawnSync } = require('node:child_process');

const HOMEBREW_ROOTS = Object.freeze(['/opt/homebrew', '/usr/local/Homebrew', '/usr/local', '/home/linuxbrew/.linuxbrew']);

function normalizeString(value) {
  return String(value == null ? '' : value).trim();
}

// `npm root -g` 是唯一可靠的答案：它把 prefix、.npmrc、nvm/volta 的改写全算进去了。
// 拿不到时回落到按 node 可执行文件推导，再拿不到就返回空 —— 空意味着「不认 npm 渠道」，
// 这是安全的一侧（不动手），绝不能猜一个目录出来。
function probeNpmGlobalRoot(options = {}) {
  const spawnSyncImpl = options.spawnSync || spawnSync;
  const processObj = options.processObj || process;
  const pathImpl = options.path || nodePath;
  const isWindows = String(processObj.platform || process.platform) === 'win32';
  try {
    const result = spawnSyncImpl(isWindows ? 'npm.cmd' : 'npm', ['root', '-g'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10_000,
      env: processObj.env
    });
    const root = normalizeString(result && result.stdout).split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    if (root) return root;
  } catch (_error) { /* 回落到推导 */ }

  const execPath = normalizeString(processObj.execPath);
  if (!execPath) return '';
  const binDir = pathImpl.dirname(execPath);
  return isWindows
    ? pathImpl.join(binDir, 'node_modules')
    : pathImpl.join(pathImpl.dirname(binDir), 'lib', 'node_modules');
}

function existingDirs(fsImpl, candidates) {
  const seen = new Set();
  const dirs = [];
  for (const candidate of candidates) {
    const value = normalizeString(candidate);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    try {
      if (fsImpl.existsSync(value)) dirs.push(value);
    } catch (_error) { /* 探测不到就当它不存在 */ }
  }
  return dirs;
}

/**
 * @returns {{npmGlobalRoot: string, standaloneRoots: string[],
 *   vendorSelfUpdateRoots: string[], homebrewRoots: string[]}}
 */
function resolveInstallRoots(options = {}) {
  const fsImpl = options.fs || nodeFs;
  const pathImpl = options.path || nodePath;
  const processObj = options.processObj || process;
  const home = normalizeString(options.hostHomeDir) || normalizeString(processObj.env && processObj.env.HOME);
  const localAppData = normalizeString(processObj.env && processObj.env.LOCALAPPDATA);

  const standaloneRoots = existingDirs(fsImpl, [
    home && pathImpl.join(home, '.codex', 'packages', 'standalone'),
    localAppData && pathImpl.join(localAppData, 'codex', 'packages', 'standalone')
  ]);

  // provider 自带更新器的布局。装进这里的二进制 aih 不接管：去 npm 再装一份只会造出
  // 与自更新器竞争 PATH 的第二份（本机 opencode 已有三份，就是这么来的）。
  const vendorSelfUpdateRoots = existingDirs(fsImpl, [
    home && pathImpl.join(home, '.local', 'share', 'claude'),
    home && pathImpl.join(home, '.claude', 'local'),
    home && pathImpl.join(home, '.opencode')
  ]);

  return {
    npmGlobalRoot: normalizeString(options.npmGlobalRoot) || probeNpmGlobalRoot({ ...options, path: pathImpl }),
    standaloneRoots,
    vendorSelfUpdateRoots,
    homebrewRoots: existingDirs(fsImpl, HOMEBREW_ROOTS)
  };
}

function npmPackageDirFor(npmGlobalRoot, packageName, options = {}) {
  const pathImpl = options.path || nodePath;
  const root = normalizeString(npmGlobalRoot);
  const pkg = normalizeString(packageName);
  if (!root || !pkg) return '';
  return pathImpl.join(root, ...pkg.split('/'));
}

module.exports = {
  HOMEBREW_ROOTS,
  probeNpmGlobalRoot,
  resolveInstallRoots,
  npmPackageDirFor
};
