'use strict';

const { buildPackagePlans } = require('./package-plans');
const {
  buildOfficialPowerShellPlans,
  powershellQuote
} = require('./shared');

function localAppData(context = {}) {
  const env = context.env || {};
  const homeDir = String(context.hostHomeDir || env.USERPROFILE || '').trim();
  return String(env.LOCALAPPDATA || (homeDir && context.path
    ? context.path.join(homeDir, 'AppData', 'Local')
    : '')).trim();
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

/**
 * Windows 终端插件的标准生命周期：有 WinGet 用 WinGet，否则走插件给出的官方 PowerShell 安装脚本。
 */
function wingetOrOfficial(terminalPackage, buildOfficialPlans) {
  return (context = {}, dependencies = {}) => {
    if (typeof dependencies.resolveExecutable !== 'function') return [];
    const executable = dependencies.resolveExecutable(['winget'], wingetFallbackPaths(context), context);
    const packagePlans = buildPackagePlans({ id: 'winget', executable }, terminalPackage.packageId, terminalPackage.label);
    return packagePlans.length ? packagePlans : buildOfficialPlans(context);
  };
}

module.exports = {
  buildOfficialPowerShellPlans,
  localAppData,
  powershellQuote,
  registeredAppUninstallScript,
  wingetOrOfficial
};
