'use strict';

const { createProviderInstaller } = require('./provider-factory');
const {
  buildPosixScriptPlan,
  buildPowerShellScriptPlan,
  buildNpmPlan,
  buildNpmUninstallPlan,
  normalizePlatform
} = require('./official-install');
const { resolvePlatformPath } = require('../../runtime/platform-path');
const { CLIENT_PLATFORMS } = require('../../runtime/client-platform');

// CodeBuddy Code CLI（@tencent-ai/codebuddy-code）官方分发包。
// npm 包是唯一权威包名；官方原生安装器（无需 Node）走 copilot.tencent.com。
const CODEBUDDY_PACKAGE = '@tencent-ai/codebuddy-code';
const CODEBUDDY_INSTALL_SH = 'https://copilot.tencent.com/cli/install.sh';
const CODEBUDDY_INSTALL_PS1 = 'https://copilot.tencent.com/cli/install.ps1';

// 原生安装器与 npm 全局安装的常见落点，卸载时需要一并清理。
const CODEBUDDY_BINARY_NAMES = Object.freeze(['codebuddy', 'cbc', 'codebuddy-code']);

/**
 * CLI 安装计划：官方脚本优先（原生安装器不需要 Node），npm 全局安装兜底。
 *
 * @param {object} [options]
 * @returns {object[]}
 */
function resolveCliInstallPlans(options = {}) {
  const platform = normalizePlatform(options);
  const official = platform === CLIENT_PLATFORMS.WINDOWS
    ? buildPowerShellScriptPlan({
      id: 'codebuddy_windows_official',
      label: 'CodeBuddy Code CLI 官方 Windows 安装器',
      url: CODEBUDDY_INSTALL_PS1,
      hosts: ['copilot.tencent.com'],
      options
    })
    : buildPosixScriptPlan({
      id: 'codebuddy_posix_official',
      label: 'CodeBuddy Code CLI 官方 macOS/Linux 安装器',
      url: CODEBUDDY_INSTALL_SH,
      hosts: ['copilot.tencent.com'],
      options
    });
  const npm = buildNpmPlan(CODEBUDDY_PACKAGE, options);
  return [official, ...(npm ? [npm] : [])];
}

/**
 * 更新计划 = 重跑官方安装器。原生安装的 CLI 由官方脚本覆盖升级，
 * npm 安装则由同一脚本内部分支处理，因此不需要单独的 npm update 计划。
 *
 * @param {object} [options]
 * @returns {object[]}
 */
function resolveCliUpdatePlans(options = {}) {
  return resolveCliInstallPlans(options);
}

/**
 * @param {object} [options]
 * @returns {object[]}
 */
function resolveCliUninstallPlans(options = {}) {
  return [buildNpmUninstallPlan(CODEBUDDY_PACKAGE, options)].filter(Boolean);
}

/**
 * 收集 CLI 可能的安装目录，供 PATH 注入与卸载清理使用。
 *
 * @param {object} [options]
 * @returns {string[]}
 */
function collectCliPathEntries(options = {}) {
  const platform = normalizePlatform(options);
  const processObj = options.processObj || process;
  const pathImpl = resolvePlatformPath(platform, options.path || require('node:path'));
  const hostHome = String(options.hostHomeDir || '').trim();
  if (!pathImpl || !hostHome) return [];

  // 官方原生安装器默认落点（官方文档：macOS/Linux 为 ~/.local/bin）。
  const entries = [pathImpl.join(hostHome, '.local', 'bin')];

  if (platform === CLIENT_PLATFORMS.WINDOWS) {
    const env = processObj.env || {};
    const localAppData = String(
      env.LOCALAPPDATA || pathImpl.join(hostHome, 'AppData', 'Local')
    ).trim();
    // 官方文档给出的 Windows 原生安装路径。
    entries.push(pathImpl.join(localAppData, 'codebuddy', 'bin'));
    entries.push(pathImpl.join(hostHome, 'AppData', 'Roaming', 'npm'));
  } else {
    // npm 全局安装落在当前 node 的 bin 目录；再补 Homebrew / 系统前缀。
    const execPath = String(processObj.execPath || '').trim();
    if (execPath) entries.push(pathImpl.dirname(execPath));
    entries.push('/opt/homebrew/bin', '/usr/local/bin');
  }
  return [...new Set(entries.filter(Boolean))];
}

module.exports = createProviderInstaller({
  provider: 'codebuddy',
  cli: {
    resolveInstallPlans: resolveCliInstallPlans,
    resolveUpdatePlans: resolveCliUpdatePlans,
    resolveUninstallPlans: resolveCliUninstallPlans,
    collectPathEntries: collectCliPathEntries,
    binaryNames: CODEBUDDY_BINARY_NAMES,
    cleanupHomeFiles: ['.local/bin/codebuddy'],
    cleanupHomeTrees: ['.local/share/codebuddy']
  },
  desktop: {
    macos: {
      // CodeBuddy IDE 由腾讯官方维护 Homebrew cask（`codebuddy`），安装
      // CodeBuddy.app（bundle id 前缀 com.tencent.codebuddy）；cask 的 arm64
      // 分发包由官方 CDN（myqcloud.com）提供，版本号 4.12.x 起。
      // cleanupHomeTrees 沿用本仓库既有口径（相对宿主 HOME，即 ~/Applications；
      // 与 zcode / kimi / qoder 的 macos 分支保持一致）。
      cask: 'codebuddy',
      cleanupHomeTrees: ['Applications/CodeBuddy.app']
    },
    windows: {
      // 2026-09-14 核实 winget-pkgs 尚无 CodeBuddy 包，且官方未公布稳定的免交互
      // 下载直链（官网只给浏览器下载页）；这里给出明确的人工安装指引，而不是
      // 伪造一个未经验证的 URL（provider-factory 的 buildDesktopInstallHint
      // 会优先取 descriptor.hint）。URL 取自 Homebrew cask `codebuddy` 的
      // homepage 字段，是当前可验证的官方 IDE 下载入口。
      hint: 'CodeBuddy IDE 暂无 Windows 免交互安装源，请从 https://www.codebuddy.ai/ide/ 下载安装后重试。',
      windowsDisplayNames: ['CodeBuddy']
    },
    linux: {
      hint: 'CodeBuddy IDE 暂无 Linux 免交互安装源，请从 https://www.codebuddy.ai/ide/ 下载 .deb 安装后重试。'
    }
  }
});
