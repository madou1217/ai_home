'use strict';

const { createProviderInstaller } = require('./provider-factory');
const {
  buildPosixScriptPlan,
  buildPowerShellScriptPlan,
  buildCaskPlan,
  buildShellPlan,
  buildPowerShellPlan,
  buildNpmPlan,
  buildCommandPlan,
  normalizePlatform
} = require('./official-install');

const OPENCODE_CLI_INSTALL = 'https://opencode.ai/install';
const OPENCODE_DOWNLOAD_PAGE = 'https://opencode.ai/download';

function collectCliPathEntries(options = {}) {
  const home = String(options.hostHomeDir || '').trim();
  if (!home) return [];
  const pathImpl = require('node:path');
  return [pathImpl.join(home, '.local', 'bin'), pathImpl.join(home, '.opencode', 'bin')];
}

function resolveCliInstallPlans(options = {}) {
  const platform = normalizePlatform(options);
  const plans = [];
  if (platform === 'macos' || platform === 'linux') {
    plans.push(buildCommandPlan(
      'homebrew_tap',
      'Homebrew 安装 OpenCode CLI（官方 tap）',
      'brew',
      ['install', 'anomalyco/tap/opencode']
    ));
  }
  const npm = buildNpmPlan('opencode-ai', options);
  if (npm) plans.push(npm);
  const plan = platform === 'windows'
    ? buildPowerShellScriptPlan({
      id: 'opencode_windows_official',
      label: 'OpenCode CLI 官方 Windows 安装器',
      url: OPENCODE_CLI_INSTALL,
      hosts: ['opencode.ai'],
      options
    })
    : buildPosixScriptPlan({
      id: 'opencode_posix_official',
      label: 'OpenCode CLI 官方 macOS/Linux 安装器',
      url: OPENCODE_CLI_INSTALL,
      hosts: ['opencode.ai'],
      options
    });
  return [...plans, plan];
}

function buildOpenCodePagePlan(options = {}) {
  if (normalizePlatform(options) === 'windows') {
    return buildPowerShellPlan('opencode_desktop_official_page', 'OpenCode 官方桌面下载页安装器', [
      `$page = (Invoke-WebRequest -Uri '${OPENCODE_DOWNLOAD_PAGE}' -UseBasicParsing).Content`,
      `$url = [regex]::Matches($page, 'https://[^\\"'' ]+\\.(?:exe|msi)') | Select-Object -First 1 | ForEach-Object { $_.Value }`,
      `if (-not $url -or ($url -notlike 'https://opencode.ai/*' -and $url -notlike 'https://github.com/*' -and $url -notlike 'https://*.githubusercontent.com/*')) { throw '未从 OpenCode 官方下载页解析到 Windows 安装器' }`,
      `$dest = Join-Path $env:TEMP ('opencode-' + [guid]::NewGuid().ToString('n') + '.exe')`,
      `try { Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing; Start-Process -FilePath $dest -Wait } finally { Remove-Item -Force $dest -ErrorAction SilentlyContinue }`
    ].join('; '), options);
  }
  const linuxArtifactPattern = '(AppImage|deb|tar\\.gz)';
  return buildShellPlan('opencode_desktop_official_page', 'OpenCode 官方桌面下载页安装器', [
    `page="$(curl -fsSL ${JSON.stringify(OPENCODE_DOWNLOAD_PAGE)})"`,
    `url="$(printf "%s" "$page" | grep -Eo "https://[^\\\" ]+\\.${linuxArtifactPattern}" | head -n1)"`,
    'case "$url" in https://opencode.ai/*|https://github.com/*|https://*.githubusercontent.com/*) ;; *) echo "未从 OpenCode 官方下载页解析到受信任安装器" >&2; exit 1;; esac',
    'case "$url" in *.deb) tmp="$(mktemp --suffix=.deb opencode.XXXXXX)"; trap "rm -f \\"$tmp\\"" EXIT; curl -fsSL "$url" -o "$tmp"; if [ "$(id -u)" -eq 0 ]; then apt-get install -y "$tmp"; else sudo -n apt-get install -y "$tmp"; fi ;; *.AppImage) root="$HOME/.local/opt/opencode"; mkdir -p "$root" "$HOME/.local/bin"; file="$root/opencode.AppImage"; curl -fsSL "$url" -o "$file"; chmod +x "$file"; ln -sf "$file" "$HOME/.local/bin/opencode" ;; *.tar.gz) root="$HOME/.local/opt/opencode"; mkdir -p "$root"; curl -fsSL "$url" | tar -xzf - -C "$root" ;; esac'
  ].join(' '));
}

module.exports = createProviderInstaller({
  provider: 'opencode',
  cli: {
    resolveInstallPlans: resolveCliInstallPlans,
    collectPathEntries: collectCliPathEntries,
    binaryNames: ['opencode']
  },
  desktop: {
    macos: { plans: [buildCaskPlan('opencode-desktop', 'Homebrew 安装 OpenCode Desktop')] },
    windows: { plans: [buildOpenCodePagePlan({ platform: 'windows' })] },
    linux: { plans: [buildOpenCodePagePlan({ platform: 'linux' })] }
  }
});
