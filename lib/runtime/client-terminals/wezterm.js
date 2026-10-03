'use strict';

const { CLIENT_PLATFORMS } = require('../client-platform');
const { resolveContext, resolveTerminalExecutable } = require('../client-terminal-support');
const {
  appTarget,
  buildOfficialShellPlans,
  homebrewOrOfficial,
  shellQuote,
  uninstallAppBundleScript,
  zipInstallScript
} = require('../client-terminal-lifecycle/macos');
const {
  buildOfficialPowerShellPlans,
  localAppData,
  powershellQuote,
  registeredAppUninstallScript,
  wingetOrOfficial
} = require('../client-terminal-lifecycle/windows');
const { flatpakOrOfficial } = require('../client-terminal-lifecycle/linux');
const { buildLinuxAppImagePlans } = require('../client-terminal-lifecycle/linux-appimage');

const WEZTERM_RELEASE_API = 'https://api.github.com/repos/wezterm/wezterm/releases/latest';

function macosOfficialPlans(context = {}) {
  const target = appTarget('WezTerm.app', context);
  const install = zipInstallScript([
    `release_json="$(curl -fsSL -H 'Accept: application/vnd.github+json' -H 'User-Agent: ai-home-toolkit' ${shellQuote(WEZTERM_RELEASE_API)})"`,
    'url="$(printf \'%s\' "$release_json" | tr \'\\n\' \' \' | sed -n \'s/.*"browser_download_url":[[:space:]]*"\\([^"]*WezTerm-macos-[^"]*\\.zip\\)".*/\\1/p\')"',
    'case "$url" in https://github.com/wezterm/wezterm/releases/download/*/WezTerm-macos-*.zip) ;; *) echo "未解析到 WezTerm 官方 macOS 发布包" >&2; exit 1;; esac'
  ].join('\n'), target, 'WezTerm.app');
  return buildOfficialShellPlans('WezTerm', {
    install,
    update: install,
    uninstall: uninstallAppBundleScript(target)
  });
}

function windowsInstallScript(context = {}) {
  const installRoot = context.path.join(localAppData(context) || 'C:\\Users\\Public\\AppData\\Local', 'Programs', 'WezTerm');
  return [
    `$release = Invoke-RestMethod -Uri ${powershellQuote(WEZTERM_RELEASE_API)} -Headers @{ Accept = 'application/vnd.github+json'; 'User-Agent' = 'ai-home-toolkit' }`,
    `$asset = $release.assets | Where-Object { $_.name -match '^WezTerm-windows-.+\\.zip$' } | Select-Object -First 1`,
    `if (-not $asset) { throw '未解析到 WezTerm 官方 Windows 发布包' }`,
    `$url = [string]$asset.browser_download_url`,
    `if (-not $url.StartsWith('https://github.com/wezterm/wezterm/releases/download/')) { throw 'WezTerm 发布地址不可信' }`,
    `$stage = Join-Path $env:TEMP ('aih-wezterm-' + [guid]::NewGuid().ToString('n'))`,
    `$archive = Join-Path $stage 'wezterm.zip'`,
    `$unpack = Join-Path $stage 'unpack'`,
    `New-Item -ItemType Directory -Force -Path $unpack | Out-Null`,
    `try {`,
    `  Invoke-WebRequest -Uri $url -OutFile $archive -UseBasicParsing`,
    `  Expand-Archive -LiteralPath $archive -DestinationPath $unpack -Force`,
    `  $executable = Get-ChildItem -LiteralPath $unpack -Recurse -File -Filter 'wezterm.exe' | Select-Object -First 1`,
    `  if (-not $executable) { throw '官方发布包中未找到 wezterm.exe' }`,
    `  $sourceRoot = $executable.Directory.FullName`,
    `  $targetRoot = ${powershellQuote(installRoot)}`,
    `  if (Test-Path -LiteralPath $targetRoot) { Remove-Item -LiteralPath $targetRoot -Recurse -Force }`,
    `  New-Item -ItemType Directory -Force -Path $targetRoot | Out-Null`,
    `  Copy-Item -Path (Join-Path $sourceRoot '*') -Destination $targetRoot -Recurse -Force`,
    `} finally { Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue }`
  ].join('\n');
}

function windowsOfficialPlans(context = {}) {
  const install = windowsInstallScript(context);
  const managedRoot = context.path.join(localAppData(context) || 'C:\\Users\\Public\\AppData\\Local', 'Programs', 'WezTerm');
  return buildOfficialPowerShellPlans('WezTerm', {
    install,
    update: install,
    uninstall: registeredAppUninstallScript(['WezTerm'], [managedRoot, context.installedPath])
  }, context);
}

function linuxOfficialPlans(context = {}) {
  return buildLinuxAppImagePlans({
    label: 'WezTerm',
    executableName: 'wezterm',
    packageNames: ['wezterm'],
    context,
    resolveUrlScript: [
      `release="$(curl -fsSL ${shellQuote(WEZTERM_RELEASE_API)})"`,
      'url="$(printf \'%s\\n\' "$release" | grep -Eo \'https://github.com/wezterm/wezterm/releases/download/[^" ]+/WezTerm-[^" ]+-Ubuntu20\\.04\\.AppImage\' | head -n1)"',
      'case "$url" in https://github.com/wezterm/wezterm/releases/download/*/WezTerm-*-Ubuntu20.04.AppImage) ;; *) echo "未找到 WezTerm 官方 AppImage" >&2; exit 1;; esac'
    ].join('\n')
  });
}

const wezterm = {
  id: 'wezterm',
  capability: 'toolkit.terminal',
  name: 'WezTerm',
  description: '跨平台 GPU 终端，支持 macOS、Windows 与 Linux。',
  sourceUrl: 'https://wezterm.org/install/',
  platforms: [CLIENT_PLATFORMS.MACOS, CLIENT_PLATFORMS.WINDOWS, CLIENT_PLATFORMS.LINUX],
  windowsOrder: 2,
  executables: {
    macos: {
      binaryNames: ['wezterm', 'wezterm-gui'],
      managedPaths: ['{hostHomeDir}/Applications/WezTerm.app/Contents/MacOS/wezterm'],
      paths: ['/Applications/WezTerm.app/Contents/MacOS/wezterm']
    },
    windows: {
      binaryNames: ['wezterm.exe', 'wezterm-gui.exe'],
      managedPaths: ['{localAppData}/Programs/WezTerm/wezterm.exe'],
      paths: ['{hostHomeDir}/scoop/apps/wezterm/current/wezterm.exe']
    },
    linux: {
      binaryNames: ['wezterm', 'wezterm-gui'],
      managedPaths: ['{hostHomeDir}/.local/bin/wezterm'],
      paths: ['/usr/bin/wezterm', '/usr/local/bin/wezterm']
    }
  },
  detect(context) {
    const executablePath = resolveTerminalExecutable(wezterm, context);
    return { installed: Boolean(executablePath), executablePath };
  },
  buildLaunch(command, title, context = {}) {
    const resolved = resolveContext(context);
    const executable = resolveTerminalExecutable(wezterm, resolved);
    if (!executable) return null;
    if (resolved.platform === CLIENT_PLATFORMS.WINDOWS) {
      return {
        terminalId: wezterm.id,
        file: executable,
        args: ['start', '--always-new-process', '--', 'cmd.exe', '/k', command]
      };
    }
    return {
      terminalId: wezterm.id,
      file: executable,
      args: ['start', '--always-new-process', '--', 'bash', '-lc', command],
      title
    };
  },
  lifecycle: {
    macos: homebrewOrOfficial({ packageId: 'wezterm', label: 'WezTerm' }, macosOfficialPlans),
    windows: wingetOrOfficial({ packageId: 'wez.wezterm', label: 'WezTerm' }, windowsOfficialPlans),
    linux: flatpakOrOfficial({ packageId: 'org.wezfurlong.wezterm', label: 'WezTerm' }, linuxOfficialPlans)
  }
};

module.exports = wezterm;
