'use strict';

const { createProviderInstaller } = require('./provider-factory');
const {
  buildPosixScriptPlan,
  buildPowerShellScriptPlan,
  buildShellPlan,
  buildPowerShellPlan,
  buildWindowsExecutableLaunchStatements,
  buildWindowsDownloadStatements,
  WINDOWS_INNO_SILENT_ARGS,
  INSTALLED_PATH_MARKER,
  normalizePlatform
} = require('./official-install');
const {
  CLIENT_ARCHITECTURES,
  CLIENT_PLATFORMS,
  getClientPlatformAdapter,
  isClientArchitectureSupported
} = require('../../runtime/client-platform');

const KIRO_CLI_SH = 'https://cli.kiro.dev/install';
const KIRO_CLI_PS1 = 'https://cli.kiro.dev/install.ps1';
// 官方下载页已改为客户端运行时装配，HTML 里不再出现安装包链接；
// 稳定入口是这张 metadata JSON（currentRelease + releases[].updateTo.url）。
const KIRO_DOWNLOAD_BASE = 'https://prod.download.desktop.kiro.dev';
const KIRO_DOWNLOAD_HOST = 'prod.download.desktop.kiro.dev';
const KIRO_METADATA_PREFIX = `${KIRO_DOWNLOAD_BASE}/stable/metadata`;
const KIRO_METADATA_SUFFIX = '-stable.json';

function collectCliPathEntries(options = {}) {
  const platform = normalizePlatform(options);
  const adapter = getClientPlatformAdapter(options);
  const pathImpl = adapter && adapter.path;
  const hostHome = String(options.hostHomeDir || '').trim();
  if (!hostHome || !pathImpl) return [];
  if (platform === CLIENT_PLATFORMS.WINDOWS) {
    const env = options.processObj && options.processObj.env || {};
    const localAppData = String(env.LOCALAPPDATA || pathImpl.join(hostHome, 'AppData', 'Local')).trim();
    const programFiles = String(env.ProgramFiles || env.PROGRAMFILES || 'C:\\Program Files').trim();
    return [pathImpl.join(localAppData, 'Kiro-Cli'), pathImpl.join(programFiles, 'Kiro-Cli')];
  }
  if (platform === CLIENT_PLATFORMS.MACOS) {
    return [pathImpl.join(hostHome, '.local', 'bin'), '/Applications/Kiro CLI.app/Contents/MacOS',
      pathImpl.join(hostHome, 'Applications', 'Kiro CLI.app', 'Contents', 'MacOS'), '/usr/local/bin'];
  }
  return [pathImpl.join(hostHome, '.local', 'bin'), '/usr/local/bin'];
}

function resolveCliInstallPlans(options = {}) {
  return [normalizePlatform(options) === CLIENT_PLATFORMS.WINDOWS
    ? buildPowerShellScriptPlan({
      id: 'kiro_windows_official',
      label: 'Kiro CLI 官方 Windows 安装器',
      url: KIRO_CLI_PS1,
      hosts: ['kiro.dev'],
      options
    })
    : buildPosixScriptPlan({
      id: 'kiro_posix_official',
      label: 'Kiro CLI 官方 macOS/Linux 安装器',
      url: KIRO_CLI_SH,
      hosts: ['kiro.dev'],
      options
    })];
}

// Kiro 的 metadata JSON 形状：{ currentRelease, releases: [{ updateTo: { url } }] }。
// 只取第一个 url 字段，且必须落在官方下载域内。
function metadataUrl(target) {
  return `${KIRO_METADATA_PREFIX}-${target}${KIRO_METADATA_SUFFIX}`;
}

function buildKiroMacPlan() {
  const script = [
    'arch="$(uname -m)"; if [ "$arch" = "arm64" ]; then target="dmg-darwin-arm64"; else target="dmg-darwin-x64"; fi',
    `payload="$(curl --compressed -fsSL "${KIRO_METADATA_PREFIX}-$target${KIRO_METADATA_SUFFIX}")"`,
    `url="$(printf "%s" "$payload" | grep -Eo '"url"[[:space:]]*:[[:space:]]*"[^"]+"' | head -n1 | sed -E 's/.*"(https:[^"]+)".*/\\1/')"`,
    `case "$url" in https://${KIRO_DOWNLOAD_HOST}/*) ;; *) echo "未从 Kiro 官方 metadata 解析到 macOS 安装器" >&2; exit 1;; esac`,
    'tmp="$(mktemp -t kiro).dmg"; mount="$(mktemp -d -t kiro-mount)"; cleanup() { hdiutil detach "$mount" -force >/dev/null 2>&1 || true; rm -rf "$mount" "$tmp"; }; trap cleanup EXIT',
    'curl -fsSL "$url" -o "$tmp"; hdiutil attach "$tmp" -nobrowse -readonly -mountpoint "$mount" >/dev/null; app="$(find "$mount" -maxdepth 1 -type d -name "Kiro.app" -print -quit)"; if [ -z "$app" ]; then app="$(find "$mount" -maxdepth 1 -type d -name "*.app" -print -quit)"; fi; if [ -z "$app" ]; then echo "Kiro.app not found" >&2; exit 1; fi; mkdir -p "$HOME/Applications"; installed="$HOME/Applications/$(basename "$app")"; ditto "$app" "$installed"; echo "' + INSTALLED_PATH_MARKER + '$installed"'
  ].join('; ');
  return buildShellPlan('kiro_desktop_macos_official_metadata', 'Kiro 官方 macOS Desktop 安装器', script);
}

function buildKiroWindowsPlan(options = {}) {
  const launch = buildWindowsExecutableLaunchStatements({
    file: '$dest',
    silentArgs: WINDOWS_INNO_SILENT_ARGS
  });
  const script = [
    `$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { 'arm64' } else { 'x64' }`,
    `$metadata = "${KIRO_METADATA_PREFIX}-win32-$arch-user${KIRO_METADATA_SUFFIX}"`,
    `$payload = (Invoke-WebRequest -Uri $metadata -UseBasicParsing).Content`,
    `$match = [regex]::Match([string]$payload, '"url"\\s*:\\s*"([^"]+)"')`,
    `if (-not $match.Success) { throw '未从 Kiro 官方 metadata 解析到 Windows 安装器' }`,
    `$url = $match.Groups[1].Value`,
    `if ($url -notlike 'https://${KIRO_DOWNLOAD_HOST}/*') { throw 'Kiro Windows 安装器地址不在官方域内' }`,
    `$dest = Join-Path $env:TEMP ('kiro-' + [guid]::NewGuid().ToString('n') + '.exe')`,
    `try { ${buildWindowsDownloadStatements({ urlExpression: '$url', label: 'Kiro 安装器' })}; ${launch} } finally { Remove-Item -Force $dest -ErrorAction SilentlyContinue }`
  ].join('; ');
  return buildPowerShellPlan('kiro_desktop_windows_official_metadata', 'Kiro 官方 Windows Desktop 安装器', script, options);
}

function buildKiroLinuxPlan() {
  const script = [
    `payload="$(curl --compressed -fsSL ${JSON.stringify(metadataUrl('linux-x64-deb'))})"`,
    `url="$(printf "%s" "$payload" | grep -Eo '"url"[[:space:]]*:[[:space:]]*"[^"]+"' | head -n1 | sed -E 's/.*"(https:[^"]+)".*/\\1/')"`,
    `case "$url" in https://${KIRO_DOWNLOAD_HOST}/*) ;; *) echo "未从 Kiro 官方 metadata 解析到 Linux 安装器" >&2; exit 1;; esac`,
    'tmp="$(mktemp --suffix=.deb kiro.XXXXXX)"; trap "rm -f \\"$tmp\\"" EXIT; curl -fsSL "$url" -o "$tmp"; if [ "$(id -u)" -eq 0 ]; then apt-get install -y "$tmp"; else sudo -n apt-get install -y "$tmp"; fi'
  ].join('; ');
  return buildShellPlan('kiro_desktop_linux_official_metadata', 'Kiro 官方 Linux Desktop 安装器', script);
}

function resolveDesktopInstallPlans(options = {}) {
  const platform = normalizePlatform(options);
  // Kiro 的 metadata 同时提供 Windows x64/arm64 安装包；Linux 仍只声明 x64。
  const x64OnlyPlatform = platform === CLIENT_PLATFORMS.LINUX;
  if (x64OnlyPlatform && !isClientArchitectureSupported(options, [CLIENT_ARCHITECTURES.X64])) {
    return [];
  }
  if (platform === CLIENT_PLATFORMS.MACOS) return [buildKiroMacPlan()];
  if (platform === CLIENT_PLATFORMS.WINDOWS) return [buildKiroWindowsPlan(options)];
  if (platform === CLIENT_PLATFORMS.LINUX) return [buildKiroLinuxPlan()];
  return [];
}

module.exports = createProviderInstaller({
  provider: 'kiro',
  cli: {
    resolveInstallPlans: resolveCliInstallPlans,
    collectPathEntries: collectCliPathEntries,
    // The macOS bundle contains both the umbrella launcher and the terminal
    // chat binary. Resolution prefers kiro-cli-chat when the sibling exists;
    // retaining both names keeps Linux/Windows installations discoverable.
    binaryNames: ['kiro-cli', 'kiro-cli-chat'],
    cleanupHomeFiles: ['.local/bin/kiro-cli', '.local/bin/kiro-cli-chat'],
    cleanupHomeTrees: ['.local/share/kiro-cli']
  },
  desktop: {
    macos: {
      resolveInstallPlans: resolveDesktopInstallPlans,
      cleanupHomeTrees: ['Applications/Kiro.app']
    },
    windows: {
      resolveInstallPlans: resolveDesktopInstallPlans,
      windowsDisplayNames: ['Kiro']
    },
    linux: {
      resolveInstallPlans: resolveDesktopInstallPlans,
      linuxPackages: ['kiro'],
      cleanupHomeFiles: ['.local/bin/kiro'],
      cleanupHomeTrees: ['.local/opt/kiro']
    }
  }
});
