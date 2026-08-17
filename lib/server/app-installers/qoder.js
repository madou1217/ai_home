'use strict';

const { createProviderInstaller } = require('./provider-factory');
const {
  buildPosixScriptPlan,
  buildPowerShellScriptPlan,
  buildMacDmgInstallPlan,
  buildWindowsExecutableInstallPlan,
  buildLinuxPackageInstallPlan,
  buildNpmPlan,
  normalizePlatform
} = require('./official-install');
const { resolvePlatformPath } = require('../../runtime/platform-path');

const QODER_CLI_SH = 'https://qoder.com/install';
const QODER_CLI_PS1 = 'https://qoder.com/install.ps1';

function resolveCliInstallPlans(options = {}) {
  const platform = normalizePlatform(options);
  const official = platform === 'windows'
    ? buildPowerShellScriptPlan({
      id: 'qoder_windows_official',
      label: 'Qoder CLI 官方 Windows 安装器',
      url: QODER_CLI_PS1,
      hosts: ['qoder.com'],
      options
    })
    : buildPosixScriptPlan({
      id: 'qoder_posix_official',
      label: 'Qoder CLI 官方 macOS/Linux 安装器',
      url: QODER_CLI_SH,
      hosts: ['qoder.com'],
      options
    });
  const npm = buildNpmPlan('@qoder-ai/qodercli', options);
  return npm ? [official, npm] : [official];
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
    pathImpl.join(hostHome, '.qoder', 'bin', 'qodercli'),
    pathImpl.join(hostHome, '.qoder', 'bin')
  ];
  if (platform === 'windows') {
    const env = processObj.env || {};
    const localAppData = String(env.LOCALAPPDATA || pathImpl.join(hostHome, 'AppData', 'Local')).trim();
    entries.push(
      pathImpl.join(localAppData, 'qodercli'),
      pathImpl.join(localAppData, 'QoderCli'),
      pathImpl.join(localAppData, 'Programs', 'Qoder'),
      pathImpl.join(String(env.ProgramFiles || 'C:\\Program Files'), 'Qoder', 'bin'),
      pathImpl.join(hostHome, 'AppData', 'Roaming', 'npm')
    );
  } else {
    entries.push('/usr/local/bin', '/opt/homebrew/bin');
  }
  return entries.filter(Boolean);
}

function resolveDesktopInstallPlans(options = {}) {
  const platform = normalizePlatform(options);
  if (platform === 'macos') {
    const arch = macArch(options);
    return [buildMacDmgInstallPlan({
      id: 'qoder_desktop_macos_official',
      label: 'Qoder 官方 macOS Desktop 安装器',
      url: `https://download.qoder.com/release/latest/Qoder-IDE-darwin-${arch}.dmg`,
      hosts: ['download.qoder.com'],
      appName: 'Qoder.app',
      options
    })];
  }
  if (platform === 'windows') {
    return [buildWindowsExecutableInstallPlan({
      id: 'qoder_desktop_windows_official',
      label: 'Qoder 官方 Windows Desktop 安装器',
      url: 'https://download.qoder.com/release/latest/QoderIDEUserSetup-x64.exe',
      hosts: ['download.qoder.com'],
      options
    })];
  }
  if (platform === 'linux') {
    return [
      buildLinuxPackageInstallPlan({
        id: 'qoder_desktop_linux_deb',
        label: 'Qoder 官方 Linux DEB 安装器',
        url: 'https://download.qoder.com/release/latest/qoder_amd64.deb',
        hosts: ['download.qoder.com'],
        packageType: 'deb'
      }),
      buildLinuxPackageInstallPlan({
        id: 'qoder_desktop_linux_rpm',
        label: 'Qoder 官方 Linux RPM 安装器',
        url: 'https://download.qoder.com/release/latest/qoder_x86_64.rpm',
        hosts: ['download.qoder.com'],
        packageType: 'rpm'
      })
    ];
  }
  return [];
}

module.exports = createProviderInstaller({
  provider: 'qoder',
  cli: {
    resolveInstallPlans: resolveCliInstallPlans,
    collectPathEntries: collectCliPathEntries,
    binaryNames: ['qodercli']
  },
  desktop: {
    macos: { resolveInstallPlans: resolveDesktopInstallPlans },
    windows: { resolveInstallPlans: resolveDesktopInstallPlans },
    linux: { resolveInstallPlans: resolveDesktopInstallPlans }
  }
});
