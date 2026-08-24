'use strict';

const { createProviderInstaller } = require('./provider-factory');
const {
  buildPosixScriptPlan,
  buildPowerShellScriptPlan,
  buildCmdScriptPlan,
  buildMacDmgInstallPlan,
  buildWindowsExecutableInstallPlan,
  buildLinuxPackageInstallPlan,
  buildNpmPlan,
  buildNpmUpdatePlan,
  buildNpmUninstallPlan,
  normalizePlatform
} = require('./official-install');
const { resolvePlatformPath } = require('../../runtime/platform-path');
const {
  CLIENT_ARCHITECTURES,
  CLIENT_PLATFORMS,
  isClientArchitectureSupported,
  resolveClientArchitecture
} = require('../../runtime/client-platform');

const QODER_CLI_SH = 'https://qoder.com/install';
const QODER_CLI_PS1 = 'https://qoder.com/install.ps1';
const QODER_CLI_CMD = 'https://qoder.com/install.cmd';

function resolveCliInstallPlans(options = {}) {
  const platform = normalizePlatform(options);
  const official = platform === CLIENT_PLATFORMS.WINDOWS
    ? buildPowerShellScriptPlan({
      id: 'qoder_windows_official',
      label: 'Qoder CLI 官方 Windows PowerShell 安装器',
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
  const cmd = platform === CLIENT_PLATFORMS.WINDOWS
    ? buildCmdScriptPlan({
      id: 'qoder_windows_cmd_official',
      label: 'Qoder CLI 官方 Windows CMD 安装器',
      url: QODER_CLI_CMD,
      hosts: ['qoder.com'],
      options
    })
    : null;
  return [official, ...(cmd ? [cmd] : []), ...(npm ? [npm] : [])];
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
    pathImpl.join(hostHome, '.qoder', 'bin', 'qodercli'),
    pathImpl.join(hostHome, '.qoder', 'bin')
  ];
  if (platform === CLIENT_PLATFORMS.WINDOWS) {
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
  const x64OnlyPlatform = platform === CLIENT_PLATFORMS.WINDOWS || platform === CLIENT_PLATFORMS.LINUX;
  if (x64OnlyPlatform && !isClientArchitectureSupported(options, [CLIENT_ARCHITECTURES.X64])) {
    return [];
  }
  if (platform === CLIENT_PLATFORMS.MACOS) {
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
  if (platform === CLIENT_PLATFORMS.WINDOWS) {
    return [buildWindowsExecutableInstallPlan({
      id: 'qoder_desktop_windows_official',
      label: 'Qoder 官方 Windows Desktop 安装器',
      url: 'https://download.qoder.com/release/latest/QoderIDEUserSetup-x64.exe',
      hosts: ['download.qoder.com'],
      options
    })];
  }
  if (platform === CLIENT_PLATFORMS.LINUX) {
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
    resolveUpdatePlans: (options = {}) => [buildNpmUpdatePlan('@qoder-ai/qodercli', options)].filter(Boolean),
    resolveUninstallPlans: (options = {}) => [buildNpmUninstallPlan('@qoder-ai/qodercli', options)].filter(Boolean),
    collectPathEntries: collectCliPathEntries,
    binaryNames: ['qodercli'],
    cleanupHomeFiles: ['.local/bin/qodercli'],
    cleanupHomeTrees: ['.qoder/bin/qodercli']
  },
  desktop: {
    macos: {
      resolveInstallPlans: resolveDesktopInstallPlans,
      cleanupHomeTrees: ['Applications/Qoder.app']
    },
    windows: {
      resolveInstallPlans: resolveDesktopInstallPlans,
      windowsDisplayNames: ['Qoder']
    },
    linux: {
      resolveInstallPlans: resolveDesktopInstallPlans,
      linuxPackages: ['qoder'],
      cleanupHomeTrees: ['.local/opt/qoder']
    }
  }
});
