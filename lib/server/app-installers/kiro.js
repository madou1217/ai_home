'use strict';

const { createProviderInstaller } = require('./provider-factory');
const {
  buildPosixScriptPlan,
  buildPowerShellScriptPlan,
  buildShellPlan,
  buildPowerShellPlan,
  normalizePlatform
} = require('./official-install');

const KIRO_CLI_SH = 'https://cli.kiro.dev/install';
const KIRO_CLI_PS1 = 'https://cli.kiro.dev/install.ps1';
const KIRO_DOWNLOAD_PAGE = 'https://kiro.dev/downloads/';

function collectCliPathEntries(options = {}) {
  const platform = normalizePlatform(options);
  const pathImpl = require('node:path');
  const hostHome = String(options.hostHomeDir || '').trim();
  if (!hostHome) return [];
  if (platform === 'win32') {
    const env = options.processObj && options.processObj.env || {};
    const localAppData = String(env.LOCALAPPDATA || pathImpl.win32.join(hostHome, 'AppData', 'Local')).trim();
    return [pathImpl.win32.join(localAppData, 'Kiro-Cli')];
  }
  return [pathImpl.posix.join(hostHome, '.local', 'bin'), '/usr/local/bin'];
}

function resolveCliInstallPlans(options = {}) {
  return [normalizePlatform(options) === 'win32'
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

function buildKiroMacPlan(options = {}) {
  const script = [
    `page="$(curl -fsSL ${JSON.stringify(KIRO_DOWNLOAD_PAGE)})"`,
    'arch="$(uname -m)"; if [ "$arch" = "arm64" ]; then target="darwin-arm64"; else target="darwin-x64"; fi',
    'url="$(printf "%s" "$page" | grep -Eo "https://prod\\.download\\.desktop\\.kiro\\.dev/releases/stable/$target/[^\\\" ]+\\.dmg" | head -n1)"',
    'case "$url" in https://prod.download.desktop.kiro.dev/*) ;; *) echo "未从 Kiro 官方下载页解析到 macOS 安装器" >&2; exit 1;; esac',
    'tmp="$(mktemp -t kiro).dmg"; mount="$(mktemp -d -t kiro-mount)"; cleanup() { hdiutil detach "$mount" -force >/dev/null 2>&1 || true; rm -rf "$mount" "$tmp"; }; trap cleanup EXIT',
    'curl -fsSL "$url" -o "$tmp"; hdiutil attach "$tmp" -nobrowse -readonly -mountpoint "$mount" >/dev/null; app="$(find "$mount" -maxdepth 1 -type d -name "Kiro.app" -print -quit)"; if [ -z "$app" ]; then app="$(find "$mount" -maxdepth 1 -type d -name "*.app" -print -quit)"; fi; if [ -z "$app" ]; then echo "Kiro.app not found" >&2; exit 1; fi; mkdir -p "$HOME/Applications"; ditto "$app" "$HOME/Applications/$(basename "$app")"'
  ].join('; ');
  // Kiro 的官方页面会随版本更新，macOS 计划在宿主机上解析稳定下载地址。
  return buildShellPlan('kiro_desktop_macos_official_page', 'Kiro 官方 macOS Desktop 下载器', script);
}

function buildKiroWindowsPlan(options = {}) {
  const script = [
    `$page = (Invoke-WebRequest -Uri '${KIRO_DOWNLOAD_PAGE}' -UseBasicParsing).Content`,
    `$url = [regex]::Matches($page, 'https://prod\\.download\\.desktop\\.kiro\\.dev/releases/stable/win32-x64/[^\\"'' ]+\\.exe') | Select-Object -First 1 | ForEach-Object { $_.Value }`,
    `if (-not $url -or $url -notlike 'https://prod.download.desktop.kiro.dev/*') { throw '未从 Kiro 官方下载页解析到 Windows 安装器' }`,
    `$dest = Join-Path $env:TEMP ('kiro-' + [guid]::NewGuid().ToString('n') + '.exe')`,
    `try { Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing; Start-Process -FilePath $dest -Wait } finally { Remove-Item -Force $dest -ErrorAction SilentlyContinue }`
  ].join('; ');
  return buildPowerShellPlan('kiro_desktop_windows_official_page', 'Kiro 官方 Windows Desktop 下载器', script, options);
}

function buildKiroLinuxPlan() {
  const script = [
    `page="$(curl -fsSL ${JSON.stringify(KIRO_DOWNLOAD_PAGE)})"`,
    'url="$(printf "%s" "$page" | grep -Eo "https://prod\\.download\\.desktop\\.kiro\\.dev/releases/stable/linux-x64/[^\\\" ]+\\.deb" | head -n1)"',
    'case "$url" in https://prod.download.desktop.kiro.dev/*) ;; *) echo "未从 Kiro 官方下载页解析到 Linux 安装器" >&2; exit 1;; esac',
    'tmp="$(mktemp --suffix=.deb kiro.XXXXXX)"; trap "rm -f \\"$tmp\\"" EXIT; curl -fsSL "$url" -o "$tmp"',
    'if [ "$(id -u)" -eq 0 ]; then apt-get install -y "$tmp"; else sudo -n apt-get install -y "$tmp"; fi'
  ].join('; ');
  return buildShellPlan('kiro_desktop_linux_official_page', 'Kiro 官方 Linux Desktop 下载器', script);
}

module.exports = createProviderInstaller({
  provider: 'kiro',
  cli: {
    resolveInstallPlans: resolveCliInstallPlans,
    collectPathEntries: collectCliPathEntries,
    binaryNames: ['kiro-cli']
  },
  desktop: {
    darwin: { plans: [buildKiroMacPlan()] },
    win32: { plans: [buildKiroWindowsPlan()] },
    linux: { plans: [buildKiroLinuxPlan()] }
  }
});
