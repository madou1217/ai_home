'use strict';

const { createProviderInstaller } = require('./provider-factory');
const {
  buildPosixScriptPlan,
  buildPowerShellScriptPlan,
  buildShellPlan,
  buildPowerShellPlan,
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
const KIRO_DOWNLOAD_PAGE = 'https://kiro.dev/downloads/';
const KIRO_DOWNLOAD_HOST = 'prod.download.desktop.kiro.dev';

function collectCliPathEntries(options = {}) {
  const platform = normalizePlatform(options);
  const adapter = getClientPlatformAdapter(options);
  const pathImpl = adapter && adapter.path;
  const hostHome = String(options.hostHomeDir || '').trim();
  if (!hostHome || !pathImpl) return [];
  if (platform === CLIENT_PLATFORMS.WINDOWS) {
    const env = options.processObj && options.processObj.env || {};
    const localAppData = String(env.LOCALAPPDATA || pathImpl.join(hostHome, 'AppData', 'Local')).trim();
    return [pathImpl.join(localAppData, 'Kiro-Cli')];
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

function buildKiroMacPlan() {
  const script = [
    `page="$(curl --compressed -fsSL ${JSON.stringify(KIRO_DOWNLOAD_PAGE)})"`,
    'arch="$(uname -m)"; if [ "$arch" = "arm64" ]; then target="darwin-arm64"; else target="darwin-x64"; fi',
    `url="$(printf "%s" "$page" | grep -Eo "https://${KIRO_DOWNLOAD_HOST}/releases/stable/$target/signed/[0-9.]+/kiro-ide-[^\\" ]+\\.dmg" | head -n1)"`,
    `case "$url" in https://${KIRO_DOWNLOAD_HOST}/*) ;; *) echo "未从 Kiro 官方下载页解析到 macOS 安装器" >&2; exit 1;; esac`,
    'tmp="$(mktemp -t kiro).dmg"; mount="$(mktemp -d -t kiro-mount)"; cleanup() { hdiutil detach "$mount" -force >/dev/null 2>&1 || true; rm -rf "$mount" "$tmp"; }; trap cleanup EXIT',
    'curl -fsSL "$url" -o "$tmp"; hdiutil attach "$tmp" -nobrowse -readonly -mountpoint "$mount" >/dev/null; app="$(find "$mount" -maxdepth 1 -type d -name "Kiro.app" -print -quit)"; if [ -z "$app" ]; then app="$(find "$mount" -maxdepth 1 -type d -name "*.app" -print -quit)"; fi; if [ -z "$app" ]; then echo "Kiro.app not found" >&2; exit 1; fi; mkdir -p "$HOME/Applications"; ditto "$app" "$HOME/Applications/$(basename "$app")"'
  ].join('; ');
  return buildShellPlan('kiro_desktop_macos_official_page', 'Kiro 官方 macOS Desktop 下载器', script);
}

function buildKiroWindowsPlan(options = {}) {
  const script = [
    `$page = (Invoke-WebRequest -Uri '${KIRO_DOWNLOAD_PAGE}' -UseBasicParsing).Content`,
    `$url = [regex]::Matches($page, 'https://${KIRO_DOWNLOAD_HOST}/releases/stable/win32-x64/signed/[0-9.]+/kiro-ide-[^\\"'' ]+\\.exe') | Select-Object -First 1 | ForEach-Object { $_.Value }`,
    `if (-not $url -or $url -notlike 'https://${KIRO_DOWNLOAD_HOST}/*') { throw '未从 Kiro 官方下载页解析到 Windows 安装器' }`,
    `$dest = Join-Path $env:TEMP ('kiro-' + [guid]::NewGuid().ToString('n') + '.exe')`,
    `try { Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing; Start-Process -FilePath $dest -Wait } finally { Remove-Item -Force $dest -ErrorAction SilentlyContinue }`
  ].join('; ');
  return buildPowerShellPlan('kiro_desktop_windows_official_page', 'Kiro 官方 Windows Desktop 下载器', script, options);
}

function buildKiroLinuxPlan() {
  const script = [
    `page="$(curl --compressed -fsSL ${JSON.stringify(KIRO_DOWNLOAD_PAGE)})"`,
    `url="$(printf "%s" "$page" | grep -Eo "https://${KIRO_DOWNLOAD_HOST}/releases/stable/linux-x64/signed/[0-9.]+/(deb|tar)/kiro-ide-[^\\" ]+\\.(deb|tar\\.gz)" | head -n1)"`,
    `case "$url" in https://${KIRO_DOWNLOAD_HOST}/*) ;; *) echo "未从 Kiro 官方下载页解析到 Linux 安装器" >&2; exit 1;; esac`,
    'case "$url" in *.deb) tmp="$(mktemp --suffix=.deb kiro.XXXXXX)"; trap "rm -f \\"$tmp\\"" EXIT; curl -fsSL "$url" -o "$tmp"; if [ "$(id -u)" -eq 0 ]; then apt-get install -y "$tmp"; else sudo -n apt-get install -y "$tmp"; fi ;; *.tar.gz) root="$HOME/.local/opt/kiro"; tmp="$(mktemp --suffix=.tar.gz kiro.XXXXXX)"; trap "rm -f \\"$tmp\\"" EXIT; mkdir -p "$root" "$HOME/.local/bin"; curl -fsSL "$url" -o "$tmp"; tar -xzf "$tmp" -C "$root"; candidate="$(find "$root" -type f \\( -name kiro -o -name Kiro \\) -perm -u+x -print -quit)"; if [ -n "$candidate" ]; then ln -sf "$candidate" "$HOME/.local/bin/kiro"; fi ;; esac'
  ].join('; ');
  return buildShellPlan('kiro_desktop_linux_official_page', 'Kiro 官方 Linux Desktop 下载器', script);
}

function resolveDesktopInstallPlans(options = {}) {
  const platform = normalizePlatform(options);
  const x64OnlyPlatform = platform === CLIENT_PLATFORMS.WINDOWS || platform === CLIENT_PLATFORMS.LINUX;
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
    binaryNames: ['kiro-cli']
  },
  desktop: {
    macos: { resolveInstallPlans: resolveDesktopInstallPlans },
    windows: { resolveInstallPlans: resolveDesktopInstallPlans },
    linux: { resolveInstallPlans: resolveDesktopInstallPlans }
  }
});
