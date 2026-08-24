'use strict';

const { createProviderInstaller } = require('./provider-factory');
const {
  buildPosixScriptPlan,
  buildPowerShellScriptPlan,
  buildCmdScriptPlan,
  buildMacDmgInstallPlan,
  buildWindowsExecutableInstallPlan,
  buildLinuxPackageInstallPlan,
  normalizePlatform
} = require('./official-install');
const { resolvePlatformPath } = require('../../runtime/platform-path');
const {
  CLIENT_ARCHITECTURES,
  CLIENT_PLATFORMS,
  isClientArchitectureSupported,
  resolveClientArchitecture
} = require('../../runtime/client-platform');

const QODERCN_CLI_SH = 'https://qoder.com.cn/install';
const QODERCN_CLI_PS1 = 'https://qoder.com.cn/install.ps1';
const QODERCN_CLI_CMD = 'https://qoder.com.cn/install.cmd';

function resolveCliInstallPlans(options = {}) {
  const platform = normalizePlatform(options);
  if (platform === CLIENT_PLATFORMS.WINDOWS) {
    return [
      buildPowerShellScriptPlan({
        id: 'qodercn_windows_official',
        label: 'Qoder CN CLI 官方 Windows PowerShell 安装器',
        url: QODERCN_CLI_PS1,
        hosts: ['qoder.com.cn'],
        options
      }),
      buildCmdScriptPlan({
        id: 'qodercn_windows_cmd_official',
        label: 'Qoder CN CLI 官方 Windows CMD 安装器',
        url: QODERCN_CLI_CMD,
        hosts: ['qoder.com.cn'],
        options
      })
    ];
  }
  return [buildPosixScriptPlan({
      id: 'qodercn_posix_official',
      label: 'Qoder CN CLI 官方 macOS/Linux 安装器',
      url: QODERCN_CLI_SH,
      hosts: ['qoder.com.cn'],
      options
    })];
}

function macArch(options = {}) {
  return resolveClientArchitecture(options) === CLIENT_ARCHITECTURES.ARM64 ? 'arm64' : 'x64';
}

function collectCliPathEntries(options = {}) {
  const platform = normalizePlatform(options);
  const processObj = options.processObj || process;
  const pathImpl = resolvePlatformPath(platform, options.path || require('node:path'));
  const hostHome = String(options.hostHomeDir || '').trim();
  if (!pathImpl || !hostHome) return [];
  const entries = [
    pathImpl.join(hostHome, '.local', 'bin'),
    pathImpl.join(hostHome, '.qoder-cn', 'bin', 'qoderclicn'),
    pathImpl.join(hostHome, '.qoder-cn', 'bin')
  ];
  if (platform === CLIENT_PLATFORMS.WINDOWS) {
    const env = processObj.env || {};
    const localAppData = String(env.LOCALAPPDATA || pathImpl.join(hostHome, 'AppData', 'Local')).trim();
    entries.push(
      pathImpl.join(localAppData, 'qoderclicn'),
      pathImpl.join(localAppData, 'QoderCli'),
      pathImpl.join(localAppData, 'Programs', 'QoderCN'),
      pathImpl.join(String(env.ProgramFiles || 'C:\\Program Files'), 'QoderCN', 'bin'),
      pathImpl.join(hostHome, 'AppData', 'Roaming', 'npm')
    );
  } else {
    entries.push('/usr/local/bin', '/opt/homebrew/bin');
  }
  return entries.filter(Boolean);
}

function resolveDesktopInstallPlans(options = {}) {
  const platform = normalizePlatform(options);
  const x64OnlyPlatform = platform === CLIENT_PLATFORMS.WINDOWS || platform === CLIENT_PLATFORMS.LINUX;
  if (x64OnlyPlatform && !isClientArchitectureSupported(options, [CLIENT_ARCHITECTURES.X64])) {
    return [];
  }
  const base = 'https://qoder-ide-cn.oss-cn-hangzhou.aliyuncs.com/qoder/release/lastest/';
  if (platform === CLIENT_PLATFORMS.MACOS) {
    return [buildMacDmgInstallPlan({
      id: 'qodercn_desktop_macos_official',
      label: 'Qoder CN 官方 macOS Desktop 安装器',
      url: `${base}Qoder-CN-IDE-darwin-${macArch(options)}.dmg`,
      hosts: ['qoder-ide-cn.oss-cn-hangzhou.aliyuncs.com'],
      options
    })];
  }
  if (platform === CLIENT_PLATFORMS.WINDOWS) {
    return [buildWindowsExecutableInstallPlan({
      id: 'qodercn_desktop_windows_official',
      label: 'Qoder CN 官方 Windows Desktop 安装器',
      url: `${base}QoderCNIDESetup-x64.exe`,
      hosts: ['qoder-ide-cn.oss-cn-hangzhou.aliyuncs.com'],
      options
    })];
  }
  if (platform === CLIENT_PLATFORMS.LINUX) {
    return [
      buildLinuxPackageInstallPlan({
        id: 'qodercn_desktop_linux_deb',
        label: 'Qoder CN 官方 Linux DEB 安装器',
        url: 'https://ide.qoder.com.cn/qoder/release/lastest/qoder-cn_amd64.deb',
        hosts: ['ide.qoder.com.cn'],
        packageType: 'deb'
      }),
      buildLinuxPackageInstallPlan({
        id: 'qodercn_desktop_linux_rpm',
        label: 'Qoder CN 官方 Linux RPM 安装器',
        url: 'https://ide.qoder.com.cn/qoder/release/lastest/qoder-cn_x86_64.rpm',
        hosts: ['ide.qoder.com.cn'],
        packageType: 'rpm'
      })
    ];
  }
  return [];
}

module.exports = createProviderInstaller({
  provider: 'qodercn',
  cli: {
    resolveInstallPlans: resolveCliInstallPlans,
    collectPathEntries: collectCliPathEntries,
    binaryNames: ['qoderclicn'],
    cleanupHomeFiles: ['.local/bin/qoderclicn'],
    cleanupHomeTrees: ['.qoder-cn/bin/qoderclicn']
  },
  desktop: {
    macos: {
      resolveInstallPlans: resolveDesktopInstallPlans,
      cleanupHomeTrees: ['Applications/Qoder CN.app', 'Applications/QoderCN.app']
    },
    windows: {
      resolveInstallPlans: resolveDesktopInstallPlans,
      windowsDisplayNames: ['Qoder CN', 'QoderCN']
    },
    linux: {
      resolveInstallPlans: resolveDesktopInstallPlans,
      linuxPackages: ['qoder-cn'],
      cleanupHomeTrees: ['.local/opt/qoder-cn']
    }
  }
});
