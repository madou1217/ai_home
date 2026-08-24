'use strict';

const { buildPackagePlans } = require('./package-plans');
const {
  buildOfficialPowerShellPlans,
  powershellQuote
} = require('./shared');

const TERMINAL_PACKAGES = Object.freeze({
  wezterm: Object.freeze({ packageId: 'wez.wezterm', label: 'WezTerm' }),
  warp: Object.freeze({ packageId: 'Warp.Warp', label: 'Warp' }),
  'windows-terminal': Object.freeze({ packageId: 'Microsoft.WindowsTerminal', label: 'Windows Terminal' })
});

const WEZTERM_RELEASE_API = 'https://api.github.com/repos/wezterm/wezterm/releases/latest';
const WINDOWS_TERMINAL_RELEASE_API = 'https://api.github.com/repos/microsoft/terminal/releases/latest';

function localAppData(context = {}) {
  const env = context.env || {};
  const homeDir = String(context.hostHomeDir || env.USERPROFILE || '').trim();
  return String(env.LOCALAPPDATA || (homeDir && context.path
    ? context.path.join(homeDir, 'AppData', 'Local')
    : '')).trim();
}

function wezTermInstallScript(context = {}) {
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

function registeredAppUninstallScript(displayNames, fallbackTargets = []) {
  const names = displayNames.map(powershellQuote).join(', ');
  const targets = fallbackTargets.filter(Boolean).map(powershellQuote).join(', ');
  return [
    `$names = @(${names})`,
    `$roots = @('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*', 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*', 'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*')`,
    `$entry = Get-ItemProperty -Path $roots -ErrorAction SilentlyContinue | Where-Object { $display = [string]$_.DisplayName; $names | Where-Object { $display -eq $_ -or $display -like ('*' + $_ + '*') } } | Select-Object -First 1`,
    `$uninstalled = $false`,
    `if ($entry) {`,
    `  $command = [string]$(if ($entry.QuietUninstallString) { $entry.QuietUninstallString } else { $entry.UninstallString })`,
    `  if (-not $command) { throw '卸载注册项没有可执行命令' }`,
    `  $process = Start-Process -FilePath $env:ComSpec -ArgumentList @('/d', '/s', '/c', $command) -Wait -PassThru`,
    `  if ($process.ExitCode -ne 0) { throw ('卸载器退出码: ' + $process.ExitCode) }`,
    `  $uninstalled = $true`,
    `}`,
    `$targets = @(${targets})`,
    `$removed = $false`,
    `foreach ($target in $targets) {`,
    `  if (-not $target -or -not (Test-Path -LiteralPath $target)) { continue }`,
    `  Remove-Item -LiteralPath $target -Recurse -Force`,
    `  $removed = $true`,
    `}`,
    `if (-not $uninstalled -and -not $removed) { throw '未找到可卸载的终端程序' }`
  ].join('\n');
}

function warpInstallScript() {
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

function windowsTerminalInstallScript() {
  return [
    `$release = Invoke-RestMethod -Uri ${powershellQuote(WINDOWS_TERMINAL_RELEASE_API)} -Headers @{ Accept = 'application/vnd.github+json'; 'User-Agent' = 'ai-home-toolkit' }`,
    `$asset = $release.assets | Where-Object { $_.name -match '^Microsoft\\.WindowsTerminal_.+_8wekyb3d8bbwe\\.msixbundle$' } | Select-Object -First 1`,
    `if (-not $asset) { throw '未解析到 Windows Terminal 官方 MSIXBundle' }`,
    `$url = [string]$asset.browser_download_url`,
    `if (-not $url.StartsWith('https://github.com/microsoft/terminal/releases/download/')) { throw 'Windows Terminal 发布地址不可信' }`,
    `$bundle = Join-Path $env:TEMP ('aih-windows-terminal-' + [guid]::NewGuid().ToString('n') + '.msixbundle')`,
    `try {`,
    `  Invoke-WebRequest -Uri $url -OutFile $bundle -UseBasicParsing`,
    `  Add-AppxPackage -Path $bundle -ForceApplicationShutdown`,
    `} finally { Remove-Item -LiteralPath $bundle -Force -ErrorAction SilentlyContinue }`
  ].join('\n');
}

function buildOfficialPlans(terminalId, context = {}) {
  const appData = localAppData(context);
  if (terminalId === 'wezterm') {
    const install = wezTermInstallScript(context);
    const managedRoot = context.path.join(appData || 'C:\\Users\\Public\\AppData\\Local', 'Programs', 'WezTerm');
    return buildOfficialPowerShellPlans('WezTerm', {
      install,
      update: install,
      uninstall: registeredAppUninstallScript(['WezTerm'], [managedRoot, context.installedPath])
    }, context);
  }
  if (terminalId === 'warp') {
    const install = warpInstallScript();
    const managedRoot = context.path.join(appData || 'C:\\Users\\Public\\AppData\\Local', 'Programs', 'Warp');
    return buildOfficialPowerShellPlans('Warp', {
      install,
      update: install,
      uninstall: registeredAppUninstallScript(['Warp'], [managedRoot, context.installedPath])
    }, context);
  }
  if (terminalId === 'windows-terminal') {
    const install = windowsTerminalInstallScript();
    return buildOfficialPowerShellPlans('Windows Terminal', {
      install,
      update: install,
      uninstall: [
        `$packages = Get-AppxPackage -Name 'Microsoft.WindowsTerminal'`,
        `if (-not $packages) { exit 0 }`,
        `$packages | Remove-AppxPackage`
      ].join('\n')
    }, context);
  }
  return [];
}

function wingetFallbackPaths(context = {}) {
  const env = context.env || {};
  const pathImpl = context.path;
  if (!pathImpl) return [];
  const homeDir = String(context.hostHomeDir || env.USERPROFILE || '').trim();
  const localAppData = String(env.LOCALAPPDATA || (homeDir
    ? pathImpl.join(homeDir, 'AppData', 'Local')
    : '')).trim();
  const programFiles = String(env.ProgramFiles || 'C:\\Program Files').trim();
  return [
    localAppData ? pathImpl.join(localAppData, 'Microsoft', 'WindowsApps', 'winget.exe') : '',
    pathImpl.join(programFiles, 'WindowsApps', 'winget.exe')
  ].filter(Boolean);
}

function buildWindowsTerminalPlans(terminalId, context = {}, dependencies = {}) {
  const terminalPackage = TERMINAL_PACKAGES[terminalId];
  if (!terminalPackage || typeof dependencies.resolveExecutable !== 'function') return [];
  const executable = dependencies.resolveExecutable(['winget'], wingetFallbackPaths(context), context);
  const packagePlans = buildPackagePlans({ id: 'winget', executable }, terminalPackage.packageId, terminalPackage.label);
  return packagePlans.length ? packagePlans : buildOfficialPlans(terminalId, context);
}

module.exports = {
  buildWindowsTerminalPlans
};
