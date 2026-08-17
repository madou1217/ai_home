'use strict';

const { createProviderInstaller } = require('./provider-factory');
const {
  buildShellPlan,
  buildPowerShellPlan,
  normalizePlatform
} = require('./official-install');

const ZCODE_DOWNLOAD_PAGE = 'https://zcode.z.ai/en';

function collectCliPathEntries(options = {}) {
  const platform = normalizePlatform(options);
  const pathImpl = require('node:path');
  const hostHome = String(options.hostHomeDir || '').trim();
  const env = options.processObj && options.processObj.env || {};
  if (platform === 'win32') {
    const programFiles = String(env.ProgramFiles || 'C:\\Program Files').trim();
    const localAppData = String(env.LOCALAPPDATA || (hostHome ? pathImpl.win32.join(hostHome, 'AppData', 'Local') : '')).trim();
    return [
      programFiles && pathImpl.win32.join(programFiles, 'ZCode', 'resources', 'glm'),
      localAppData && pathImpl.win32.join(localAppData, 'Programs', 'ZCode', 'resources', 'glm')
    ].filter(Boolean);
  }
  return ['/Applications/ZCode.app/Contents/Resources/glm', '/usr/local/bin'];
}

function buildZcodeMacPlan() {
  const script = [
    `page="$(curl -fsSL ${JSON.stringify(ZCODE_DOWNLOAD_PAGE)})"`,
    'arch="$(uname -m)"; if [ "$arch" = "arm64" ]; then target="macos-arm64"; else target="macos-x64"; fi',
    'url="$(printf "%s" "$page" | grep -Eo "https://cdn-zcode\\.z\\.ai/zcode/electron/releases/[^\\\" ]+/$target/ZCode-[^\\\" ]+\\.dmg" | head -n1)"',
    'case "$url" in https://cdn-zcode.z.ai/*) ;; *) echo "未从 ZCode 官方页面解析到 macOS 安装器" >&2; exit 1;; esac',
    'tmp="$(mktemp -t zcode).dmg"; mount="$(mktemp -d -t zcode-mount)"; cleanup() { hdiutil detach "$mount" -force >/dev/null 2>&1 || true; rm -rf "$mount" "$tmp"; }; trap cleanup EXIT',
    'curl -fsSL "$url" -o "$tmp"; hdiutil attach "$tmp" -nobrowse -readonly -mountpoint "$mount" >/dev/null; app="$(find "$mount" -maxdepth 1 -type d -name "ZCode.app" -print -quit)"; if [ -z "$app" ]; then app="$(find "$mount" -maxdepth 1 -type d -name "*.app" -print -quit)"; fi; if [ -z "$app" ]; then echo "ZCode.app not found" >&2; exit 1; fi; mkdir -p "$HOME/Applications"; ditto "$app" "$HOME/Applications/$(basename "$app")"'
  ].join('; ');
  return buildShellPlan('zcode_desktop_macos_official_page', 'ZCode 官方 macOS Desktop 下载器', script);
}

function buildZcodeWindowsPlan(options = {}) {
  const script = [
    `$page = (Invoke-WebRequest -Uri '${ZCODE_DOWNLOAD_PAGE}' -UseBasicParsing).Content`,
    `$arch = if ([Environment]::Is64BitOperatingSystem) { 'x64' } else { 'arm64' }`,
    `$pattern = 'https://cdn-zcode\\.z\\.ai/zcode/electron/releases/[^\\"'' ]+/windows-' + $arch + '/ZCode-[^\\"'' ]+\\.win-' + $arch + '\\.exe'`,
    `$url = [regex]::Matches($page, $pattern) | Select-Object -First 1 | ForEach-Object { $_.Value }`,
    `if (-not $url -or $url -notlike 'https://cdn-zcode.z.ai/*') { throw '未从 ZCode 官方页面解析到 Windows 安装器' }`,
    `$dest = Join-Path $env:TEMP ('zcode-' + [guid]::NewGuid().ToString('n') + '.exe')`,
    `try { Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing; Start-Process -FilePath $dest -Wait } finally { Remove-Item -Force $dest -ErrorAction SilentlyContinue }`
  ].join('; ');
  return buildPowerShellPlan('zcode_desktop_windows_official_page', 'ZCode 官方 Windows Desktop 下载器', script, options);
}

function buildZcodeLinuxPlan() {
  const script = [
    `page="$(curl -fsSL ${JSON.stringify(ZCODE_DOWNLOAD_PAGE)})"`,
    'arch="$(uname -m)"; if [ "$arch" = "aarch64" ] || [ "$arch" = "arm64" ]; then target="linux-arm64"; else target="linux-x64"; fi',
    'url="$(printf "%s" "$page" | grep -Eo "https://cdn-zcode\\.z\\.ai/zcode/electron/releases/[^\\\" ]+/$target/ZCode-[^\\\" ]+\\.$target\\.deb" | head -n1)"',
    'case "$url" in https://cdn-zcode.z.ai/*) ;; *) echo "未从 ZCode 官方页面解析到 Linux 安装器" >&2; exit 1;; esac',
    'tmp="$(mktemp --suffix=.deb zcode.XXXXXX)"; trap "rm -f \\"$tmp\\"" EXIT; curl -fsSL "$url" -o "$tmp"; if [ "$(id -u)" -eq 0 ]; then apt-get install -y "$tmp"; else sudo -n apt-get install -y "$tmp"; fi'
  ].join('; ');
  return buildShellPlan('zcode_desktop_linux_official_page', 'ZCode 官方 Linux Desktop 下载器', script);
}

module.exports = createProviderInstaller({
  provider: 'zcode',
  cli: {
    collectPathEntries: collectCliPathEntries,
    binaryNames: ['zcode.cjs', 'zcode']
  },
  desktop: {
    darwin: { plans: [buildZcodeMacPlan()] },
    win32: { plans: [buildZcodeWindowsPlan()] },
    linux: { plans: [buildZcodeLinuxPlan()] }
  }
});
