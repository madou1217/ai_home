'use strict';

const { createProviderInstaller } = require('./provider-factory');
const {
  buildPosixScriptPlan,
  buildPowerShellPlan,
  buildPowerShellScriptPlan,
  buildCommandPlan,
  buildShellPlan,
  buildNpmPlan,
  buildNpmUpdatePlan,
  buildNpmUninstallPlan,
  normalizePlatform
} = require('./official-install');
const {
  CLIENT_ARCHITECTURES,
  CLIENT_PLATFORMS,
  getClientPlatformAdapter,
  isClientArchitectureSupported
} = require('../../runtime/client-platform');

const KIMI_INSTALL_SH = 'https://code.kimi.com/kimi-code/install.sh';
const KIMI_INSTALL_PS1 = 'https://code.kimi.com/kimi-code/install.ps1';
const KIMI_DESKTOP_MACOS_DOWNLOAD = 'https://appsupport.kimi.ai/api/app/pkg/latest/macos/download';
const KIMI_DESKTOP_WINDOWS_DOWNLOAD = 'https://appsupport.kimi.ai/api/app/pkg/latest/windows/download';
const KIMI_DESKTOP_MACOS_DOWNLOAD_HOST = 'kimi-img.moonshot.cn';

function buildKimiMacPlan() {
  const script = [
    `endpoint=${JSON.stringify(KIMI_DESKTOP_MACOS_DOWNLOAD)}`,
    'root="$(mktemp -d -t kimi-install)"',
    'headers="$root/headers"',
    'tmp="$root/Kimi.dmg"',
    'mount="$root/mount"',
    'install_root="$HOME/Applications"',
    'target="$install_root/Kimi.app"',
    'stage="$install_root/.Kimi.app.aih-stage-$$"',
    'backup="$install_root/.Kimi.app.aih-backup-$$"',
    'installed=0',
    'mkdir -p "$mount"',
    'cleanup() { hdiutil detach "$mount" -force >/dev/null 2>&1 || true; if [ "$installed" -ne 1 ] && [ -d "$backup" ] && [ ! -e "$target" ]; then mv "$backup" "$target"; fi; rm -rf "$stage" "$backup" "$root"; }',
    'trap cleanup EXIT',
    'curl --compressed -fsS --proto "=https" --max-redirs 0 -D "$headers" -o /dev/null "$endpoint"',
    'url="$(awk \'tolower($1) == "location:" { sub(/\\r$/, "", $2); print $2; exit }\' "$headers")"',
    `case "$url" in https://${KIMI_DESKTOP_MACOS_DOWNLOAD_HOST}/*) ;; *) echo "未从 Kimi 官方端点解析到 macOS 安装器" >&2; exit 1;; esac`,
    'curl --compressed -fsSL --proto "=https" --max-redirs 0 "$url" -o "$tmp"',
    'hdiutil attach "$tmp" -nobrowse -readonly -mountpoint "$mount" >/dev/null',
    'app="$mount/Kimi Installer.app/Contents/Helpers/Kimi.app"',
    'if [ ! -d "$app" ]; then echo "Kimi.app not found in official installer bundle" >&2; exit 1; fi',
    'bundle_id="$(/usr/bin/plutil -extract CFBundleIdentifier raw "$app/Contents/Info.plist" 2>/dev/null || true)"',
    'if [ "$bundle_id" != "com.moonshot.kimichat" ]; then echo "unexpected Kimi bundle identifier: $bundle_id" >&2; exit 1; fi',
    '/usr/bin/codesign --verify --deep --strict "$app"',
    'team_id="$(/usr/bin/codesign -dv --verbose=4 "$app" 2>&1 | /usr/bin/awk -F= \'$1 == "TeamIdentifier" { print $2; exit }\')"',
    'if [ "$team_id" != "2J9472RW75" ]; then echo "unexpected Kimi signing team: $team_id" >&2; exit 1; fi',
    'mkdir -p "$install_root"',
    '/usr/bin/ditto "$app" "$stage"',
    '/usr/bin/codesign --verify --deep --strict "$stage"',
    'if [ -e "$target" ]; then mv "$target" "$backup"; fi',
    'mv "$stage" "$target"',
    'installed=1'
  ].join('; ');
  return buildShellPlan('kimi_desktop_macos_official', 'Kimi 官方 macOS Desktop 下载器', script);
}

function buildKimiWindowsPlan(options = {}) {
  const script = [
    `$endpoint = '${KIMI_DESKTOP_WINDOWS_DOWNLOAD}'`,
    `$request = [System.Net.HttpWebRequest]::Create($endpoint)`,
    `$request.AllowAutoRedirect = $false`,
    `$response = $request.GetResponse()`,
    `try { $url = [string]$response.Headers['Location'] } finally { $response.Close() }`,
    `$uri = [Uri]$url`,
    `if ($uri.Scheme -ne 'https' -or $uri.Host -ne '${KIMI_DESKTOP_MACOS_DOWNLOAD_HOST}' -or $uri.AbsolutePath -notmatch '^/app/download/windows/kimi_[0-9.]+\\.exe$') { throw '未从 Kimi 官方端点解析到 Windows 安装器' }`,
    `$dest = Join-Path $env:TEMP ('kimi-' + [guid]::NewGuid().ToString('n') + '.exe')`,
    `try { Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing; $signature = Get-AuthenticodeSignature -FilePath $dest; if ($signature.Status -ne 'Valid') { throw ('Kimi 安装器签名无效: ' + $signature.Status) }; if ($signature.SignerCertificate.Subject -notmatch 'Moonshot') { throw ('Kimi 安装器发布者不匹配: ' + $signature.SignerCertificate.Subject) }; $process = Start-Process -FilePath $dest -ArgumentList '/S' -Wait -PassThru; if ($process.ExitCode -ne 0) { throw ('Kimi 安装器退出码: ' + $process.ExitCode) } } finally { Remove-Item -Force $dest -ErrorAction SilentlyContinue }`
  ].join('; ');
  return buildPowerShellPlan('kimi_desktop_windows_official', 'Kimi 官方 Windows Desktop 下载器', script, options);
}

function resolveDesktopInstallPlans(options = {}) {
  const platform = normalizePlatform(options);
  if (platform === CLIENT_PLATFORMS.MACOS) {
    return isClientArchitectureSupported(options, [CLIENT_ARCHITECTURES.ARM64])
      ? [buildKimiMacPlan()]
      : [];
  }
  if (platform === CLIENT_PLATFORMS.WINDOWS) {
    return isClientArchitectureSupported(options, [CLIENT_ARCHITECTURES.X64])
      ? [buildKimiWindowsPlan(options)]
      : [];
  }
  return [];
}

function collectCliPathEntries(options = {}) {
  const home = String(options.hostHomeDir || '').trim();
  const adapter = getClientPlatformAdapter(options);
  return home && adapter ? [adapter.path.join(home, '.local', 'bin')] : [];
}

module.exports = createProviderInstaller({
  provider: 'kimi',
  desktop: {
    macos: { resolveInstallPlans: resolveDesktopInstallPlans },
    windows: { resolveInstallPlans: resolveDesktopInstallPlans }
  },
  cli: {
    resolveInstallPlans: (options = {}) => {
      const platform = normalizePlatform(options);
      const adapter = getClientPlatformAdapter(options);
      const official = platform === CLIENT_PLATFORMS.WINDOWS
        ? buildPowerShellScriptPlan({
          id: 'kimi_windows_official',
          label: 'Kimi Code CLI 官方 Windows 安装器',
          url: KIMI_INSTALL_PS1,
          hosts: ['kimi.com'],
          options
        })
        : buildPosixScriptPlan({
          id: 'kimi_posix_official',
          label: 'Kimi Code CLI 官方 macOS/Linux 安装器',
          url: KIMI_INSTALL_SH,
          hosts: ['kimi.com'],
          options
        });
      const uv = buildCommandPlan(
        'kimi_uv_official',
        'uv 安装 Kimi Code CLI（官方文档）',
        (adapter && adapter.commands.uv) || 'uv',
        ['tool', 'install', '--python', '3.13', 'kimi-cli']
      );
      const npm = buildNpmPlan('@moonshot-ai/kimi-code', options);
      return npm ? [official, uv, npm] : [official, uv];
    },
    resolveUpdatePlans: (options = {}) => [buildNpmUpdatePlan('@moonshot-ai/kimi-code', options)].filter(Boolean),
    resolveUninstallPlans: (options = {}) => [buildNpmUninstallPlan('@moonshot-ai/kimi-code', options)].filter(Boolean),
    collectPathEntries: collectCliPathEntries,
    binaryNames: ['kimi']
  }
});
