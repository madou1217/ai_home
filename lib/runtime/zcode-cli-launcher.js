'use strict';

// **ZCode CLI 的定位与启动垫片**（唯一实现处）。
//
// 事实来源（2026-10-27 本机实测 ZCode 0.17.0 / Desktop 3.16.3）：
//   * CLI 不是独立分发的二进制，而是随 Desktop 一起下发的 **node bundle**：
//       <ZCode.app>/Contents/Resources/glm/zcode.cjs        （15 MB，`node <file>` 可跑）
//     Linux 侧 Desktop 安装器会额外落一个 `~/.local/bin/zcode` 符号链接指向 AppImage，
//     因此「可执行名」有两个候选：`zcode`（Linux 符号链接）与 `zcode.cjs`（bundle 内）。
//   * 它**不能**被直接 exec（没有可执行位/shebang 语义），必须 `node <cjs> …`；
//   * 它要求两个**成对**的 provider 配置环境变量，缺任一个直接退出：
//       「无法定位 CLI ZCode Built-in Provider Config：<a>, <b>」
//     - ZCODE_BUILTIN_PROVIDER_CONFIG_FILE  = <ZCode.app>/Contents/Resources/config/provider/zcode-builtin.json
//     - ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = <ZCODE_DATA_BASE_DIR>/.zcode/v2/provider_config.json
//     CLI **不自己创建**个人配置：文件缺失时同样报上面那个错（实测）。
//   * 数据根 `ZCODE_DATA_BASE_DIR` 的 CLI 语义是 `<base>/.zcode`（与 Desktop 宿主不同，
//     见 lib/server/desktop-launch/zcode-strategy.js 的说明），由 launch-profile 注入。
//
// 因此这里做三件事，且只做这三件：
//   1) 定位 bundle 内的 CLI 与内置 provider 配置；
//   2) 按需生成一个 **POSIX/Windows 启动垫片**（补两个 env、按需建空个人配置、exec node）；
//   3) 把垫片路径交回给通用 CLI 解析链 —— 通用链只认识「一个可执行文件路径」。
// 不碰已安装的 App bundle（改它等于破坏代码签名，桌面侧的影子 App 机制正是为此存在）。

const nodeFs = require('node:fs');
const nodePath = require('node:path');
const nodeOs = require('node:os');

// bundle 内的相对路径（顺序即查找顺序）。
const ZCODE_BUNDLED_CLI_SUBPATH = Object.freeze(['Contents', 'Resources', 'glm', 'zcode.cjs']);
const ZCODE_BUNDLED_CONFIG_SUBPATH = Object.freeze([
  'Contents', 'Resources', 'config', 'provider', 'zcode-builtin.json'
]);

// Desktop 的安装位置（与 builtins.go 的 desktopClient.installPaths 同源）。
const ZCODE_APP_BUNDLE_TOKENS = Object.freeze([
  '/Applications/ZCode.app',
  '{hostHomeDir}/Applications/ZCode.app'
]);

// 个人 provider 配置的**空形态**：CLI 自己写出来的就是这一份（真机对照
// run/auth-projections/zcode/<ref>/.zcode/v2/provider_config.json 逐字节一致）。
// 只在文件缺失时落一份，绝不覆盖已有内容。
const ZCODE_EMPTY_PERSONAL_PROVIDER_CONFIG = JSON.stringify({
  schemaVersion: 1,
  config: {
    providerConfigRules: { providerRules: [] },
    modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] }
  }
}, null, 2) + '\n';

function expandBundleToken(token, hostHomeDir) {
  return String(token || '').trim().replace('{hostHomeDir}', String(hostHomeDir || '').trim());
}

function fileExists(fs, target) {
  try {
    return Boolean(target) && fs.existsSync(target) && fs.statSync(target).isFile();
  } catch (_error) {
    return false;
  }
}

/**
 * 定位 ZCode CLI（bundle 内的 `zcode.cjs`）。
 *
 * @param {object} [options]
 * @param {string} [options.hostHomeDir] 宿主 HOME（`~/Applications` 安装位置）
 * @param {object} [options.fs]          fs 注入（测试用）
 * @returns {{cliPath: string, bundlePath: string, configPath: string}|null}
 */
function resolveZcodeBundledCli(options = {}) {
  const fs = options.fs || nodeFs;
  const path = options.path || nodePath;
  const hostHomeDir = String(options.hostHomeDir || '').trim();
  const candidates = ZCODE_APP_BUNDLE_TOKENS
    .map((token) => expandBundleToken(token, hostHomeDir))
    .filter(Boolean);
  for (const bundlePath of candidates) {
    const cliPath = path.join(bundlePath, ...ZCODE_BUNDLED_CLI_SUBPATH);
    if (!fileExists(fs, cliPath)) continue;
    const configPath = path.join(bundlePath, ...ZCODE_BUNDLED_CONFIG_SUBPATH);
    return { cliPath, bundlePath, configPath: fileExists(fs, configPath) ? configPath : '' };
  }
  return null;
}

/**
 * bundle 内的 CLI 搜索目录（`Contents/Resources/glm`）。
 * 交给通用解析链当 PATH 条目用 —— 通用链按「binaryName + 策略声明的名字」在该目录里找文件。
 */
function collectZcodeBundledCliPathEntries(options = {}) {
  const path = options.path || nodePath;
  const hostHomeDir = String(options.hostHomeDir || '').trim();
  return ZCODE_APP_BUNDLE_TOKENS
    .map((token) => expandBundleToken(token, hostHomeDir))
    .filter(Boolean)
    .map((bundlePath) => path.join(bundlePath, 'Contents', 'Resources', 'glm'));
}

/**
 * 垫片目录：宿主 `~/.ai_home/bin`（与 aih 托管资源的既有位置一致）。
 * 放在 aih 自己的目录而不是账号沙箱里 —— 它与账号无关，一份即可。
 */
function resolveZcodeLauncherDir(options = {}) {
  const path = options.path || nodePath;
  const aiHomeDir = String(options.aiHomeDir || '').trim()
    || path.join(nodeOs.homedir(), '.ai_home');
  return path.join(aiHomeDir, 'bin');
}

// POSIX 垫片：补两个 env（缺 BUILTIN/PERSONAL 时 CLI 直接退出）、按需落一份空的
// 个人 provider 配置，然后 exec node。
// 用 `sh` 而不是 bash：垫片要在最小环境（容器 / 无 bash 的 macOS 以外系统）里也能跑。
function buildPosixLauncherSource(input) {
  const emptyConfigLiteral = `'${ZCODE_EMPTY_PERSONAL_PROVIDER_CONFIG.replace(/'/g, "'\\''")}'`;
  return [
    '#!/bin/sh',
    '# 由 aih 生成，请勿手工编辑（见 lib/runtime/zcode-cli-launcher.js）。',
    '# ZCode CLI 是 node bundle：补 provider 配置环境变量后 exec node。',
    'node_bin=' + JSON.stringify(String(input.nodeExecutable || '').trim()),
    'cli=' + JSON.stringify(String(input.cliPath || '').trim()),
    'builtin=' + JSON.stringify(String(input.configPath || '').trim()),
    'data_root="${ZCODE_DATA_BASE_DIR:-$HOME}"',
    'personal="${ZCODE_PERSONAL_PROVIDER_CONFIG_FILE:-$data_root/.zcode/v2/provider_config.json}"',
    'if [ -n "$builtin" ] && [ ! -f "$builtin" ]; then builtin=""; fi',
    'if [ -n "$builtin" ]; then',
    '  ZCODE_BUILTIN_PROVIDER_CONFIG_FILE="$builtin"',
    '  export ZCODE_BUILTIN_PROVIDER_CONFIG_FILE',
    'fi',
    'if [ -n "$personal" ] && [ ! -f "$personal" ]; then',
    '  mkdir -p "$(dirname "$personal")" 2>/dev/null || true',
    '  printf %s ' + emptyConfigLiteral + ' > "$personal" 2>/dev/null || true',
    'fi',
    'if [ -n "$personal" ] && [ -f "$personal" ]; then',
    '  ZCODE_PERSONAL_PROVIDER_CONFIG_FILE="$personal"',
    '  export ZCODE_PERSONAL_PROVIDER_CONFIG_FILE',
    'fi',
    'exec "$node_bin" "$cli" "$@"',
    ''
  ].join('\n');
}

function buildWindowsLauncherSource(input) {
  const emptyConfigJson = JSON.stringify({
    schemaVersion: 1,
    config: {
      providerConfigRules: { providerRules: [] },
      modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] }
    }
  });
  return [
    '@echo off',
    'rem 由 aih 生成，请勿手工编辑（见 lib/runtime/zcode-cli-launcher.js）。',
    'setlocal',
    'set "node_bin=' + String(input.nodeExecutable || '').trim() + '"',
    'set "cli=' + String(input.cliPath || '').trim() + '"',
    'set "builtin=' + String(input.configPath || '').trim() + '"',
    'if not defined ZCODE_DATA_BASE_DIR set "ZCODE_DATA_BASE_DIR=%USERPROFILE%"',
    'if not defined ZCODE_PERSONAL_PROVIDER_CONFIG_FILE set "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE=%ZCODE_DATA_BASE_DIR%\\.zcode\\v2\\provider_config.json"',
    'if defined builtin if not exist "%builtin%" set "builtin="',
    'if defined builtin set "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE=%builtin%"',
    'if not exist "%ZCODE_PERSONAL_PROVIDER_CONFIG_FILE%" (',
    '  if not exist "%ZCODE_DATA_BASE_DIR%\\.zcode\\v2" mkdir "%ZCODE_DATA_BASE_DIR%\\.zcode\\v2" 2>nul',
    '  >"%ZCODE_PERSONAL_PROVIDER_CONFIG_FILE%" echo ' + emptyConfigJson,
    ')',
    '"%node_bin%" "%cli%" %*',
    'exit /b %ERRORLEVEL%',
    ''
  ].join('\r\n');
}

/**
 * 生成（或刷新）ZCode CLI 启动垫片，返回垫片路径。
 * 内容变化时才写（与桌面侧 ensureAgentLauncher 同款幂等）。
 *
 * @param {object} input
 * @param {string} input.cliPath         bundle 内的 `zcode.cjs`
 * @param {string} [input.configPath]    内置 provider 配置（空串时垫片不注入该项）
 * @param {string} [input.nodeExecutable] 运行 node（默认当前进程）
 * @param {string} [input.aiHomeDir]     宿主 aiHome（默认 `~/.ai_home`）
 * @param {string} [input.platform]      目标平台（默认当前平台）
 * @returns {string} 垫片绝对路径；无法生成时返回空串（调用方回退到原路径）
 */
function ensureZcodeCliLauncher(input = {}) {
  const fs = input.fs || nodeFs;
  const path = input.path || nodePath;
  const platform = String(input.platform || process.platform || '').trim();
  const cliPath = String(input.cliPath || '').trim();
  if (!cliPath) return '';
  if (typeof fs.mkdirSync !== 'function' || typeof fs.writeFileSync !== 'function') return '';
  const dir = resolveZcodeLauncherDir({ path, aiHomeDir: input.aiHomeDir });
  const launcherName = platform === 'win32' ? 'zcode.cmd' : 'zcode';
  const launcherPath = path.join(dir, launcherName);
  const source = platform === 'win32'
    ? buildWindowsLauncherSource({ ...input, cliPath })
    : buildPosixLauncherSource({ ...input, cliPath });
  try {
    fs.mkdirSync(dir, { recursive: true });
    let current = '';
    try { current = fs.readFileSync(launcherPath, 'utf8'); } catch (_readError) { /* 首次生成 */ }
    if (current !== source) fs.writeFileSync(launcherPath, source, { mode: 0o700 });
    if (platform !== 'win32' && typeof fs.chmodSync === 'function') fs.chmodSync(launcherPath, 0o700);
  } catch (_error) {
    return '';
  }
  return launcherPath;
}

module.exports = {
  ZCODE_BUNDLED_CLI_SUBPATH,
  ZCODE_BUNDLED_CONFIG_SUBPATH,
  ZCODE_APP_BUNDLE_TOKENS,
  ZCODE_EMPTY_PERSONAL_PROVIDER_CONFIG,
  resolveZcodeBundledCli,
  collectZcodeBundledCliPathEntries,
  resolveZcodeLauncherDir,
  ensureZcodeCliLauncher
};
