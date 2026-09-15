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

// CodeBuddy Code 国内站（copilot.tencent.com）安装源。
//
// 与 codebuddy（国际站）的关系（2026-09-14 实测）：
//   - CLI 是**同一个 npm 包**（@tencent-ai/codebuddy-code），官方 install.sh
//     从 myqcloud COS 拉同一份 releases；站点在首次登录时选择，并由
//     CODEBUDDY_INTERNET_ENVIRONMENT=internal 固定。所以这里复用同一 package，
//     只是把"官方入口"指向国内域名。
//   - 桌面端是**另一个 App**：CodeBuddy CN.app（bundle id com.tencent.codebuddycn），
//     官方 Homebrew cask 为 `codebuddy-cn`。国际站的 cask `codebuddy` 装的是
//     CodeBuddy.app，两者不可互换，因此不能共用 codebuddy.js 的桌面计划。
const CODEBUDDY_PACKAGE = '@tencent-ai/codebuddy-code';
const CODEBUDDY_CN_INSTALL_SH = 'https://copilot.tencent.com/cli/install.sh';
const CODEBUDDY_CN_INSTALL_PS1 = 'https://copilot.tencent.com/cli/install.ps1';

const CODEBUDDY_BINARY_NAMES = Object.freeze(['codebuddy', 'cbc', 'codebuddy-code']);

/**
 * CLI 安装计划：官方国内脚本优先（原生安装器不需要 Node），npm 全局安装兜底。
 *
 * @param {object} [options]
 * @returns {object[]}
 */
function resolveCliInstallPlans(options = {}) {
  const platform = normalizePlatform(options);
  const official = platform === CLIENT_PLATFORMS.WINDOWS
    ? buildPowerShellScriptPlan({
      id: 'codebuddycn_windows_official',
      label: 'CodeBuddy Code CN CLI 官方 Windows 安装器',
      url: CODEBUDDY_CN_INSTALL_PS1,
      hosts: ['copilot.tencent.com'],
      options
    })
    : buildPosixScriptPlan({
      id: 'codebuddycn_posix_official',
      label: 'CodeBuddy Code CN CLI 官方 macOS/Linux 安装器',
      url: CODEBUDDY_CN_INSTALL_SH,
      hosts: ['copilot.tencent.com'],
      options
    });
  const npm = buildNpmPlan(CODEBUDDY_PACKAGE, options);
  return [official, ...(npm ? [npm] : [])];
}

/**
 * 更新计划 = 重跑官方安装器（与国际站同理：官方脚本自带升级分支）。
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
 * 收集 CLI 可能的安装目录（与国际站同落点，官方脚本用同一个 ~/.local/bin）。
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

  const entries = [pathImpl.join(hostHome, '.local', 'bin')];

  if (platform === CLIENT_PLATFORMS.WINDOWS) {
    const env = processObj.env || {};
    const localAppData = String(
      env.LOCALAPPDATA || pathImpl.join(hostHome, 'AppData', 'Local')
    ).trim();
    entries.push(pathImpl.join(localAppData, 'codebuddy', 'bin'));
    entries.push(pathImpl.join(hostHome, 'AppData', 'Roaming', 'npm'));
  } else {
    const execPath = String(processObj.execPath || '').trim();
    if (execPath) entries.push(pathImpl.dirname(execPath));
    entries.push('/opt/homebrew/bin', '/usr/local/bin');
  }
  return [...new Set(entries.filter(Boolean))];
}

module.exports = createProviderInstaller({
  provider: 'codebuddycn',
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
      // 官方 Homebrew cask `codebuddy-cn` 装 CodeBuddy CN.app
      // （bundle id com.tencent.codebuddycn，homepage copilot.tencent.com/ide/）。
      // 实测 `brew info --cask codebuddy-cn` 为 4.12.0.37847260，与 codebuddy
      // 同版本发布，说明两条站点并行维护。
      cask: 'codebuddy-cn',
      cleanupHomeTrees: ['Applications/CodeBuddy CN.app', 'Applications/CodeBuddyCN.app']
    },
    windows: {
      // 官方只提供浏览器下载页，没有可验证的免交互安装源（不伪造 URL）。
      hint: 'CodeBuddy CN IDE 暂无 Windows 免交互安装源，请从 https://copilot.tencent.com/ide/ 下载安装后重试。',
      windowsDisplayNames: ['CodeBuddy CN']
    },
    linux: {
      hint: 'CodeBuddy CN IDE 暂无 Linux 免交互安装源，请从 https://copilot.tencent.com/ide/ 下载安装后重试。'
    }
  }
});
