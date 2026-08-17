'use strict';

const { createProviderInstaller } = require('./provider-factory');
const {
  buildPosixScriptPlan,
  buildPowerShellScriptPlan,
  buildMacDmgInstallPlan,
  buildWindowsExecutableInstallPlan,
  buildLinuxPackageInstallPlan,
  normalizePlatform
} = require('./official-install');
const { resolvePlatformPath } = require('../../runtime/platform-path');

const QODERCN_CLI_SH = 'https://qoder.com.cn/install';
const QODERCN_CLI_PS1 = 'https://qoder.com.cn/install.ps1';

function resolveCliInstallPlans(options = {}) {
  return [normalizePlatform(options) === 'windows'
    ? buildPowerShellScriptPlan({
      id: 'qodercn_windows_official',
      label: 'Qoder CN CLI 官方 Windows 安装器',
      url: QODERCN_CLI_PS1,
      hosts: ['qoder.com.cn'],
      options
    })
    : buildPosixScriptPlan({
      id: 'qodercn_posix_official',
      label: 'Qoder CN CLI 官方 macOS/Linux 安装器',
      url: QODERCN_CLI_SH,
      hosts: ['qoder.com.cn'],
      options
    })];
}

function macArch(options = {}) {
  const arch = String(options.arch || options.processObj && options.processObj.arch || process.arch).toLowerCase();
  return arch === 'arm64' ? 'arm64' : 'x64';
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
  if (platform === 'windows') {
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
  const base = 'https://qoder-ide-cn.oss-cn-hangzhou.aliyuncs.com/qoder/release/lastest/';
  if (platform === 'macos') {
    return [buildMacDmgInstallPlan({
      id: 'qodercn_desktop_macos_official',
      label: 'Qoder CN 官方 macOS Desktop 安装器',
      url: `${base}Qoder-CN-IDE-darwin-${macArch(options)}.dmg`,
      hosts: ['qoder-ide-cn.oss-cn-hangzhou.aliyuncs.com'],
      options
    })];
  }
  if (platform === 'windows') {
    return [buildWindowsExecutableInstallPlan({
      id: 'qodercn_desktop_windows_official',
      label: 'Qoder CN 官方 Windows Desktop 安装器',
      url: `${base}QoderCNIDESetup-x64.exe`,
      hosts: ['qoder-ide-cn.oss-cn-hangzhou.aliyuncs.com'],
      options
    })];
  }
  if (platform === 'linux') {
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
    binaryNames: ['qoderclicn']
  },
  desktop: {
    macos: { resolveInstallPlans: resolveDesktopInstallPlans },
    windows: { resolveInstallPlans: resolveDesktopInstallPlans },
    linux: { resolveInstallPlans: resolveDesktopInstallPlans }
  }
});
