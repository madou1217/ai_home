'use strict';

const {
  CLIENT_ARCHITECTURES,
  CLIENT_PLATFORMS,
  resolveClientArchitecture
} = require('../client-platform');
const { resolveContext, resolveTerminalExecutable } = require('../client-terminal-support');
const {
  appTarget,
  buildOfficialShellPlans,
  dmgInstallScript,
  homebrewOrOfficial,
  uninstallAppBundleScript
} = require('../client-terminal-lifecycle/macos');
const {
  buildOfficialPowerShellPlans,
  localAppData,
  registeredAppUninstallScript,
  wingetOrOfficial
} = require('../client-terminal-lifecycle/windows');
const { buildWarpLinuxPlans } = require('../client-terminal-lifecycle/warp-linux');

function macosOfficialPlans(context = {}) {
  const target = appTarget('Warp.app', context);
  const architecture = resolveClientArchitecture(context);
  const packageName = architecture === CLIENT_ARCHITECTURES.ARM64 ? 'dmg_arm64' : 'dmg_x86_64';
  const install = dmgInstallScript(`https://app.warp.dev/download?package=${packageName}`, target, 'Warp.app');
  return buildOfficialShellPlans('Warp', {
    install,
    update: install,
    uninstall: uninstallAppBundleScript(target)
  });
}

function windowsInstallScript() {
  return [
    `$url = 'https://app.warp.dev/download?package=windows'`,
    `$installer = Join-Path $env:TEMP ('aih-warp-' + [guid]::NewGuid().ToString('n') + '.exe')`,
    `try {`,
    `  Invoke-WebRequest -Uri $url -OutFile $installer -UseBasicParsing`,
    `  $signature = Get-AuthenticodeSignature -LiteralPath $installer`,
    `  if ($signature.Status -ne 'Valid') { throw ('Warp 安装包签名校验失败: ' + $signature.Status) }`,
    `  $process = Start-Process -FilePath $installer -ArgumentList @('/VERYSILENT', '/NORESTART', '/CURRENTUSER') -Wait -PassThru`,
    `  if ($process.ExitCode -ne 0) { throw ('Warp 安装器退出码: ' + $process.ExitCode) }`,
    `} finally { Remove-Item -LiteralPath $installer -Force -ErrorAction SilentlyContinue }`
  ].join('\n');
}

function windowsOfficialPlans(context = {}) {
  const install = windowsInstallScript();
  const managedRoot = context.path.join(localAppData(context) || 'C:\\Users\\Public\\AppData\\Local', 'Programs', 'Warp');
  return buildOfficialPowerShellPlans('Warp', {
    install,
    update: install,
    uninstall: registeredAppUninstallScript(['Warp'], [managedRoot, context.installedPath])
  }, context);
}

const warp = {
  id: 'warp',
  capability: 'toolkit.terminal',
  name: 'Warp',
  description: '跨平台现代终端，支持 macOS、Windows 与 Linux。',
  sourceUrl: 'https://www.warp.dev/terminal',
  platforms: [CLIENT_PLATFORMS.MACOS, CLIENT_PLATFORMS.WINDOWS, CLIENT_PLATFORMS.LINUX],
  windowsOrder: 3,
  executables: {
    macos: {
      binaryNames: [],
      managedPaths: ['{hostHomeDir}/Applications/Warp.app/Contents/MacOS/stable'],
      paths: ['/Applications/Warp.app/Contents/MacOS/stable']
    },
    windows: {
      binaryNames: ['warp.exe', 'Warp.exe'],
      managedPaths: ['{localAppData}/Programs/Warp/Warp.exe'],
      paths: ['{hostHomeDir}/AppData/Local/Programs/Warp/Warp.exe']
    },
    linux: {
      binaryNames: ['warp-terminal'],
      managedPaths: ['{hostHomeDir}/.local/bin/warp-terminal'],
      paths: ['/usr/bin/warp-terminal', '/usr/local/bin/warp-terminal']
    }
  },
  detect(context) {
    const executablePath = resolveTerminalExecutable(warp, context);
    return { installed: Boolean(executablePath), executablePath };
  },
  buildLaunch(_command, title, context = {}) {
    const resolved = resolveContext(context);
    const executable = resolveTerminalExecutable(warp, resolved);
    if (!executable) return null;
    if (resolved.platform === CLIENT_PLATFORMS.MACOS) {
      return { terminalId: warp.id, file: '/usr/bin/open', args: ['-n', '-a', 'Warp'], title };
    }
    return { terminalId: warp.id, file: executable, args: [], title };
  },
  lifecycle: {
    macos: homebrewOrOfficial({ packageId: 'warp', label: 'Warp' }, macosOfficialPlans),
    windows: wingetOrOfficial({ packageId: 'Warp.Warp', label: 'Warp' }, windowsOfficialPlans),
    linux: buildWarpLinuxPlans
  }
};

module.exports = warp;
