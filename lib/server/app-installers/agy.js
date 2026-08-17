'use strict';

const { createProviderInstaller } = require('./provider-factory');
const {
  buildPosixScriptPlan,
  buildPowerShellScriptPlan,
  buildCmdScriptPlan,
  buildShellPlan,
  buildPowerShellPlan,
  normalizePlatform
} = require('./official-install');
const { CLIENT_PLATFORMS, getClientPlatformAdapter } = require('../../runtime/client-platform');

const AGY_CLI_SH = 'https://antigravity.google/cli/install.sh';
const AGY_CLI_PS1 = 'https://antigravity.google/cli/install.ps1';
const AGY_CLI_CMD = 'https://antigravity.google/cli/install.cmd';
const AGY_DOWNLOAD_PAGE = 'https://antigravity.google/download';

function collectCliPathEntries(options = {}) {
  const home = String(options.hostHomeDir || '').trim();
  const adapter = getClientPlatformAdapter(options);
  return home && adapter ? [adapter.path.join(home, '.local', 'bin')] : [];
}

function resolveCliInstallPlans(options = {}) {
  if (normalizePlatform(options) === CLIENT_PLATFORMS.WINDOWS) {
    return [
      buildPowerShellScriptPlan({
        id: 'agy_windows_official',
        label: 'Antigravity CLI 官方 Windows PowerShell 安装器',
        url: AGY_CLI_PS1,
        hosts: ['antigravity.google'],
        options
      }),
      buildCmdScriptPlan({
        id: 'agy_windows_cmd_official',
        label: 'Antigravity CLI 官方 Windows CMD 安装器',
        url: AGY_CLI_CMD,
        hosts: ['antigravity.google'],
        options
      })
    ];
  }
  return [buildPosixScriptPlan({
    id: 'agy_posix_official',
    label: 'Antigravity CLI 官方 macOS/Linux 安装器',
    url: AGY_CLI_SH,
    hosts: ['antigravity.google'],
    options
  })];
}

function buildAntigravityPosixDesktopPlan() {
  const script = [
    `page="$(curl --compressed -fsSL ${JSON.stringify(AGY_DOWNLOAD_PAGE)})"`,
    'arch="$(uname -m)"',
    'if [ "$(uname -s)" = "Darwin" ]; then',
    '  if [ "$arch" = "arm64" ]; then pattern="darwin-arm/Antigravity\\.dmg"; else pattern="darwin-x64/Antigravity\\.dmg"; fi',
    '  url="$(printf "%s" "$page" | grep -Eo "https://storage\\.googleapis\\.com/antigravity-public/[^\\\" ]+/$pattern" | head -n1)"',
    '  case "$url" in https://storage.googleapis.com/antigravity-public/*) ;; *) echo "未从官方页面解析到 Antigravity macOS 下载地址" >&2; exit 1;; esac',
    '  tmp="$(mktemp -t antigravity).dmg"; mount="$(mktemp -d -t antigravity-mount)"',
    '  cleanup() { hdiutil detach "$mount" -force >/dev/null 2>&1 || true; rm -rf "$mount" "$tmp"; }; trap cleanup EXIT',
    '  curl -fsSL "$url" -o "$tmp"; hdiutil attach "$tmp" -nobrowse -readonly -mountpoint "$mount" >/dev/null',
    '  app="$(find "$mount" -maxdepth 1 -type d -name "Antigravity.app" -print -quit)"; if [ -z "$app" ]; then echo "Antigravity.app not found" >&2; exit 1; fi',
    '  mkdir -p "$HOME/Applications"; ditto "$app" "$HOME/Applications/Antigravity.app"',
    'else',
    '  if [ "$arch" = "aarch64" ] || [ "$arch" = "arm64" ]; then pattern="linux-arm/Antigravity\\.tar\\.gz"; else pattern="linux-x64/Antigravity\\.tar\\.gz"; fi',
    '  url="$(printf "%s" "$page" | grep -Eo "https://storage\\.googleapis\\.com/antigravity-public/[^\\\" ]+/$pattern" | head -n1)"',
    '  case "$url" in https://storage.googleapis.com/antigravity-public/*) ;; *) echo "未从官方页面解析到 Antigravity Linux 下载地址" >&2; exit 1;; esac',
    '  root="$HOME/.local/opt/antigravity"; tmp="$(mktemp --suffix=.tar.gz antigravity.XXXXXX)"; trap "rm -f \\"$tmp\\"" EXIT',
    '  mkdir -p "$root" "$HOME/.local/bin"; curl -fsSL "$url" -o "$tmp"; tar -xzf "$tmp" -C "$root"',
    '  candidate="$(find "$root" -type f \\( -name agy -o -name antigravity \\) -perm -u+x -print -quit)"; if [ -n "$candidate" ]; then ln -sf "$candidate" "$HOME/.local/bin/agy"; fi',
    'fi'
  ].join('\n');
  return buildShellPlan('agy_desktop_official_page', 'Antigravity 官方桌面下载页安装器', script);
}

function buildAntigravityWindowsDesktopPlan(options = {}) {
  const script = [
    `$page = (Invoke-WebRequest -Uri '${AGY_DOWNLOAD_PAGE}' -UseBasicParsing).Content`,
    `$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { 'arm' } else { 'x64' }`,
    `$pattern = 'https://storage\\.googleapis\\.com/antigravity-public/[^\\"'' ]+/windows-' + $arch + '/Antigravity-[^\\"'' ]+\\.exe'`,
    `$url = [regex]::Matches($page, $pattern) | Select-Object -First 1 | ForEach-Object { $_.Value }`,
    `if (-not $url -or $url -notlike 'https://storage.googleapis.com/antigravity-public/*') { throw '未从官方页面解析到 Antigravity Windows 下载地址' }`,
    `$dest = Join-Path $env:TEMP ('antigravity-' + [guid]::NewGuid().ToString('n') + '.exe')`,
    `try { Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing; Start-Process -FilePath $dest -Wait } finally { Remove-Item -Force $dest -ErrorAction SilentlyContinue }`
  ].join('; ');
  return buildPowerShellPlan('agy_desktop_official_page', 'Antigravity 官方桌面下载页安装器', script, options);
}

module.exports = createProviderInstaller({
  provider: 'agy',
  cli: {
    resolveInstallPlans: resolveCliInstallPlans,
    collectPathEntries: collectCliPathEntries,
    binaryNames: ['agy']
  },
  desktop: {
    macos: { plans: [buildAntigravityPosixDesktopPlan()] },
    windows: { plans: [buildAntigravityWindowsDesktopPlan()] },
    linux: { plans: [buildAntigravityPosixDesktopPlan()] }
  }
});
