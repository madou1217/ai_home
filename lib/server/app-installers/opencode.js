'use strict';

const { createProviderInstaller } = require('./provider-factory');
const {
  buildPosixScriptPlan,
  buildPowerShellScriptPlan,
  buildCaskPlan,
  buildNpmPlan,
  buildCommandPlan,
  buildWindowsExecutableInstallPlan,
  buildLinuxPackageInstallPlan,
  normalizePlatform
} = require('./official-install');
const {
  CLIENT_ARCHITECTURES,
  CLIENT_PLATFORMS,
  getClientPlatformAdapter,
  isClientArchitectureSupported
} = require('../../runtime/client-platform');

const OPENCODE_CLI_INSTALL = 'https://opencode.ai/install';
// OpenCode 的下载页把稳定渠道映射到这些官方下载端点；端点本身不带
// 文件后缀，因此使用对应的安装器构造器补充本地临时文件类型。
const OPENCODE_DESKTOP_WINDOWS = 'https://dev.opencode.ai/download/stable/windows-x64-nsis';
const OPENCODE_DESKTOP_LINUX_DEB = 'https://dev.opencode.ai/download/stable/linux-x64-deb';
const OPENCODE_DESKTOP_LINUX_RPM = 'https://dev.opencode.ai/download/stable/linux-x64-rpm';

function collectCliPathEntries(options = {}) {
  const home = String(options.hostHomeDir || '').trim();
  const adapter = getClientPlatformAdapter(options);
  if (!home || !adapter) return [];
  const pathImpl = adapter.path;
  return [pathImpl.join(home, '.local', 'bin'), pathImpl.join(home, '.opencode', 'bin')];
}

function resolveCliInstallPlans(options = {}) {
  const platform = normalizePlatform(options);
  const plans = [];
  if (platform === CLIENT_PLATFORMS.MACOS || platform === CLIENT_PLATFORMS.LINUX) {
    plans.push(buildCommandPlan(
      'homebrew_tap',
      'Homebrew 安装 OpenCode CLI（官方 tap）',
      'brew',
      ['install', 'anomalyco/tap/opencode']
    ));
  }
  const npm = buildNpmPlan('opencode-ai', options);
  if (npm) plans.push(npm);
  const plan = platform === CLIENT_PLATFORMS.WINDOWS
    ? buildPowerShellScriptPlan({
      id: 'opencode_windows_official',
      label: 'OpenCode CLI 官方 Windows 安装器',
      url: OPENCODE_CLI_INSTALL,
      hosts: ['opencode.ai'],
      options
    })
    : buildPosixScriptPlan({
      id: 'opencode_posix_official',
      label: 'OpenCode CLI 官方 macOS/Linux 安装器',
      url: OPENCODE_CLI_INSTALL,
      hosts: ['opencode.ai'],
      options
    });
  return [...plans, plan];
}

function resolveDesktopInstallPlans(options = {}) {
  const platform = normalizePlatform(options);
  const x64OnlyPlatform = platform === CLIENT_PLATFORMS.WINDOWS || platform === CLIENT_PLATFORMS.LINUX;
  if (x64OnlyPlatform && !isClientArchitectureSupported(options, [CLIENT_ARCHITECTURES.X64])) {
    return [];
  }
  if (platform === CLIENT_PLATFORMS.WINDOWS) {
    return [buildWindowsExecutableInstallPlan({
      id: 'opencode_desktop_windows_official',
      label: 'OpenCode 官方 Windows Desktop 稳定安装器',
      url: OPENCODE_DESKTOP_WINDOWS,
      hosts: ['dev.opencode.ai'],
      options
    })];
  }
  return [
    buildLinuxPackageInstallPlan({
      id: 'opencode_desktop_linux_deb',
      label: 'OpenCode 官方 Linux DEB 稳定安装器',
      url: OPENCODE_DESKTOP_LINUX_DEB,
      hosts: ['dev.opencode.ai'],
      packageType: 'deb'
    }),
    buildLinuxPackageInstallPlan({
      id: 'opencode_desktop_linux_rpm',
      label: 'OpenCode 官方 Linux RPM 稳定安装器',
      url: OPENCODE_DESKTOP_LINUX_RPM,
      hosts: ['dev.opencode.ai'],
      packageType: 'rpm'
    })
  ];
}

module.exports = createProviderInstaller({
  provider: 'opencode',
  cli: {
    resolveInstallPlans: resolveCliInstallPlans,
    collectPathEntries: collectCliPathEntries,
    binaryNames: ['opencode']
  },
  desktop: {
    macos: { plans: [buildCaskPlan('opencode-desktop', 'Homebrew 安装 OpenCode Desktop')] },
    windows: { resolveInstallPlans: resolveDesktopInstallPlans },
    linux: { resolveInstallPlans: resolveDesktopInstallPlans }
  }
});
