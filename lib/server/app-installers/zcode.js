'use strict';

const { createProviderInstaller } = require('./provider-factory');
const {
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

const ZCODE_DOWNLOAD_PAGE = 'https://zcode.z.ai/en/docs/install';
const ZCODE_DOWNLOAD_HOST = 'cdn-zcode.z.ai';

function collectCliPathEntries(options = {}) {
  const platform = normalizePlatform(options);
  const adapter = getClientPlatformAdapter(options);
  const pathImpl = adapter && adapter.path;
  const hostHome = String(options.hostHomeDir || '').trim();
  const env = options.processObj && options.processObj.env || {};
  if (!pathImpl) return [];
  if (platform === CLIENT_PLATFORMS.WINDOWS) {
    const programFiles = String(env.ProgramFiles || 'C:\\Program Files').trim();
    const localAppData = String(env.LOCALAPPDATA || (hostHome ? pathImpl.join(hostHome, 'AppData', 'Local') : '')).trim();
    return [
      programFiles && pathImpl.join(programFiles, 'ZCode', 'resources', 'glm'),
      localAppData && pathImpl.join(localAppData, 'Programs', 'ZCode', 'resources', 'glm')
    ].filter(Boolean);
  }
  return ['/Applications/ZCode.app/Contents/Resources/glm', '/usr/local/bin'];
}

function buildZcodeMacPlan() {
  const script = [
    `page="$(curl --compressed -fsSL ${JSON.stringify(ZCODE_DOWNLOAD_PAGE)})"`,
    'arch="$(uname -m)"; if [ "$arch" = "arm64" ]; then target="macos-arm64"; else target="macos-x64"; fi',
    `url="$(printf "%s" "$page" | grep -Eo "https://${ZCODE_DOWNLOAD_HOST}/zcode/electron/releases/[^\\" ]+/$target/ZCode-[^\\" ]+-(mac|darwin)-[^\\" ]+\\.dmg" | head -n1)"`,
    `case "$url" in https://${ZCODE_DOWNLOAD_HOST}/*) ;; *) echo "未从 ZCode 官方页面解析到 macOS 安装器" >&2; exit 1;; esac`,
    'tmp="$(mktemp -t zcode).dmg"; mount="$(mktemp -d -t zcode-mount)"; cleanup() { hdiutil detach "$mount" -force >/dev/null 2>&1 || true; rm -rf "$mount" "$tmp"; }; trap cleanup EXIT',
    'curl -fsSL "$url" -o "$tmp"; hdiutil attach "$tmp" -nobrowse -readonly -mountpoint "$mount" >/dev/null; app="$(find "$mount" -maxdepth 1 -type d -name "ZCode.app" -print -quit)"; if [ -z "$app" ]; then app="$(find "$mount" -maxdepth 1 -type d -name "*.app" -print -quit)"; fi; if [ -z "$app" ]; then echo "ZCode.app not found" >&2; exit 1; fi; mkdir -p "$HOME/Applications"; ditto "$app" "$HOME/Applications/$(basename "$app")"'
  ].join('; ');
  return buildShellPlan('zcode_desktop_macos_official_page', 'ZCode 官方 macOS Desktop 下载器', script);
}

function buildZcodeWindowsPlan(options = {}) {
  const script = [
    `$page = (Invoke-WebRequest -Uri '${ZCODE_DOWNLOAD_PAGE}' -UseBasicParsing).Content`,
    `$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { 'arm64' } else { 'x64' }`,
    `$pattern = 'https://${ZCODE_DOWNLOAD_HOST}/zcode/electron/releases/[^\\"'' ]+/windows-' + $arch + '/ZCode-[^\\"'' ]+-win-' + $arch + '\\.exe'`,
    `$url = [regex]::Matches($page, $pattern) | Select-Object -First 1 | ForEach-Object { $_.Value }`,
    `if (-not $url -or $url -notlike 'https://${ZCODE_DOWNLOAD_HOST}/*') { throw '未从 ZCode 官方页面解析到 Windows 安装器' }`,
    `$dest = Join-Path $env:TEMP ('zcode-' + [guid]::NewGuid().ToString('n') + '.exe')`,
    `try { Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing; Start-Process -FilePath $dest -Wait } finally { Remove-Item -Force $dest -ErrorAction SilentlyContinue }`
  ].join('; ');
  return buildPowerShellPlan('zcode_desktop_windows_official_page', 'ZCode 官方 Windows Desktop 下载器', script, options);
}

function buildZcodeLinuxPlan() {
  const script = [
    `page="$(curl --compressed -fsSL ${JSON.stringify(ZCODE_DOWNLOAD_PAGE)})"`,
    'arch="$(uname -m)"; case "$arch" in x86_64|amd64) target="linux-x64" ;; *) echo "ZCode Linux Desktop 官方仅支持 x64" >&2; exit 1 ;; esac',
    `url="$(printf "%s" "$page" | grep -Eo "https://${ZCODE_DOWNLOAD_HOST}/zcode/electron/releases/[^\\" ]+/$target/ZCode-[^\\" ]+\\.AppImage" | head -n1)"`,
    `case "$url" in https://${ZCODE_DOWNLOAD_HOST}/*) ;; *) echo "未从 ZCode 官方页面解析到 Linux AppImage" >&2; exit 1;; esac`,
    'root="$HOME/.local/opt/zcode"; file="$root/ZCode.AppImage"; mkdir -p "$root" "$HOME/.local/bin"; curl -fsSL "$url" -o "$file"; chmod +x "$file"; ln -sf "$file" "$HOME/.local/bin/zcode"'
  ].join('; ');
  return buildShellPlan('zcode_desktop_linux_official_page', 'ZCode 官方 Linux AppImage 安装器', script);
}

function resolveDesktopInstallPlans(options = {}) {
  const platform = normalizePlatform(options);
  if (platform === CLIENT_PLATFORMS.LINUX
    && !isClientArchitectureSupported(options, [CLIENT_ARCHITECTURES.X64])) {
    return [];
  }
  if (platform === CLIENT_PLATFORMS.MACOS) return [buildZcodeMacPlan()];
  if (platform === CLIENT_PLATFORMS.WINDOWS) return [buildZcodeWindowsPlan(options)];
  if (platform === CLIENT_PLATFORMS.LINUX) return [buildZcodeLinuxPlan()];
  return [];
}

module.exports = createProviderInstaller({
  provider: 'zcode',
  cli: {
    collectPathEntries: collectCliPathEntries,
    binaryNames: ['zcode.cjs', 'zcode']
  },
  desktop: {
    macos: { resolveInstallPlans: resolveDesktopInstallPlans },
    windows: { resolveInstallPlans: resolveDesktopInstallPlans },
    linux: { resolveInstallPlans: resolveDesktopInstallPlans }
  }
});
