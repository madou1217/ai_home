'use strict';

// 共享的安装计划构造器只负责跨平台命令骨架和 URL 安全校验，不保存任何
// Provider 名单或来源。每个 provider 文件仍必须声明自己的官方 URL、包名和
// 安装方式，从而新增 Provider 只增加一个独立模块。
const {
  CLIENT_PLATFORMS,
  getClientPlatformAdapter,
  resolveClientPlatform
} = require('../../runtime/client-platform');
const { buildManagedPathCleanupPlan } = require('../../runtime/managed-path-cleaner');

function normalizePlatform(options = {}) {
  return resolveClientPlatform(options);
}

const NPM_PUBLIC_REGISTRY = 'https://registry.npmjs.org';

// 安装包静默参数属于「安装器打包格式」的事实，集中在这里，provider 只声明用哪一族。
// Inno Setup 不认 NSIS 的 /S；用错会把安装器留在交互界面直到超时。
const WINDOWS_INNO_SILENT_ARGS = Object.freeze([
  '/VERYSILENT',
  '/SUPPRESSMSGBOXES',
  '/NORESTART',
  '/SP-'
]);
const WINDOWS_NSIS_SILENT_ARGS = Object.freeze(['/S']);

// AIH 安装计划把最终落点写进 stdout，作业管理器据此做精确校验（不靠猜包名）。
const INSTALLED_PATH_MARKER = 'AIH_DESKTOP_INSTALLED_PATH=';

function buildNpmIsolationArgs(options = {}) {
  const platform = normalizePlatform(options);
  const userConfig = platform === CLIENT_PLATFORMS.WINDOWS ? 'NUL' : '/dev/null';
  return [
    `--userconfig=${userConfig}`,
    `--registry=${NPM_PUBLIC_REGISTRY}`
  ];
}

function withNpmIsolation(args, options = {}) {
  const baseArgs = Array.isArray(args) ? args.map((arg) => String(arg)) : [];
  const withoutOverrides = baseArgs.filter((arg) => !/^--(?:userconfig|registry)(?:=|$)/i.test(arg));
  return withoutOverrides.concat(buildNpmIsolationArgs(options));
}

function assertOfficialUrl(value, allowedHosts = []) {
  const url = new URL(String(value || '').trim());
  const hosts = (Array.isArray(allowedHosts) ? allowedHosts : [allowedHosts])
    .map((host) => String(host || '').trim().toLowerCase())
    .filter(Boolean);
  if (url.protocol !== 'https:') throw new Error(`official installer URL must use HTTPS: ${url}`);
  if (hosts.length && !hosts.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))) {
    throw new Error(`official installer URL host is not allowlisted: ${url.hostname}`);
  }
  return url.toString();
}

function shellQuote(value) {
  return `'${String(value || '').replace(/'/g, `'\\''`)}'`;
}

function powershellQuote(value) {
  return `'${String(value || '').replace(/'/g, "''")}'`;
}

function buildShellPlan(id, label, script, timeoutMs = 30 * 60 * 1000) {
  return {
    id: String(id || '').trim(),
    label: String(label || '').trim(),
    command: 'bash',
    args: ['-c', `set -euo pipefail; ${String(script || '').trim()}`],
    timeoutMs
  };
}

function buildPowerShellPlan(id, label, script, options = {}) {
  const adapter = getClientPlatformAdapter(CLIENT_PLATFORMS.WINDOWS);
  const processObj = options.processObj || process;
  const systemRoot = String(processObj.env && (processObj.env.SystemRoot || processObj.env.SYSTEMROOT) || '').trim();
  const powershell = systemRoot
    ? adapter.path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : adapter.commands.shell;
  return {
    id: String(id || '').trim(),
    label: String(label || '').trim(),
    command: powershell,
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', [
      "$ErrorActionPreference = 'Stop'",
      "$ProgressPreference = 'SilentlyContinue'",
      String(script || '').trim()
    ].join('; ')],
    timeoutMs: 30 * 60 * 1000
  };
}

function buildPosixScriptPlan({ id, label, url, hosts, options = {} }) {
  const officialUrl = assertOfficialUrl(url, hosts);
  const home = String(options.hostHomeDir || '').trim();
  const tempDir = home ? `${shellQuote(require('node:path').posix.join(home, '.cache', 'ai-home-installs'))}` : '"${TMPDIR:-/tmp}"';
  const script = [
    `tmp_dir=${tempDir}`,
    'mkdir -p "$tmp_dir"',
    'script="$tmp_dir/aih-installer-$$.sh"',
    'trap \'rm -f "$script"\' EXIT',
    `curl --compressed -fsSL ${shellQuote(officialUrl)} -o "$script"`,
    'bash "$script"'
  ].join('; ');
  return buildShellPlan(id, label, script);
}

function buildPowerShellScriptPlan({ id, label, url, hosts, options = {} }) {
  const officialUrl = assertOfficialUrl(url, hosts);
  const script = [
    `$dest = Join-Path $env:TEMP ('aih-installer-' + [guid]::NewGuid().ToString('n') + '.ps1')`,
    `Invoke-WebRequest -Uri ${powershellQuote(officialUrl)} -OutFile $dest -UseBasicParsing`,
    'try { & $dest } finally { Remove-Item -Force $dest -ErrorAction SilentlyContinue }'
  ].join('; ');
  return buildPowerShellPlan(id, label, script, options);
}

function buildCmdScriptPlan({ id, label, url, hosts, options = {} }) {
  const officialUrl = assertOfficialUrl(url, hosts);
  const adapter = getClientPlatformAdapter(CLIENT_PLATFORMS.WINDOWS);
  const script = [
    'set "dest=%TEMP%\\aih-installer-%RANDOM%.cmd"',
    `curl.exe -fsSL "${officialUrl}" -o "%dest%"`,
    'call "%dest%"',
    'del /f /q "%dest%"'
  ].join(' && ');
  return {
    id: String(id || '').trim(),
    label: String(label || '').trim(),
    command: adapter.commands.cmd,
    args: ['/d', '/s', '/c', script],
    timeoutMs: 30 * 60 * 1000
  };
}

function buildNpmPlan(packageName, options = {}) {
  const pkg = String(packageName || '').trim();
  if (!pkg) return null;
  const adapter = getClientPlatformAdapter(normalizePlatform(options));
  return {
    id: 'npm_global',
    label: `npm 全局安装 ${pkg}`,
    command: adapter ? adapter.commands.npm : 'npm',
    args: withNpmIsolation(['install', '--global', pkg], options),
    timeoutMs: 20 * 60 * 1000
  };
}

function buildNpmUpdatePlan(packageName, options = {}) {
  const pkg = String(packageName || '').trim();
  if (!pkg) return null;
  const adapter = getClientPlatformAdapter(normalizePlatform(options));
  return {
    id: 'npm_global_update',
    label: `npm 全局更新 ${pkg}`,
    command: adapter ? adapter.commands.npm : 'npm',
    args: withNpmIsolation(['install', '--global', `${pkg}@latest`], options),
    timeoutMs: 20 * 60 * 1000
  };
}

function buildNpmUninstallPlan(packageName, options = {}) {
  const pkg = String(packageName || '').trim();
  if (!pkg) return null;
  const adapter = getClientPlatformAdapter(normalizePlatform(options));
  return {
    id: 'npm_global_uninstall',
    label: `npm 全局卸载 ${pkg}`,
    command: adapter ? adapter.commands.npm : 'npm',
    args: withNpmIsolation(['uninstall', '--global', pkg], options),
    timeoutMs: 20 * 60 * 1000
  };
}

function buildCommandPlan(id, label, command, args = [], timeoutMs = 30 * 60 * 1000) {
  return {
    id: String(id || '').trim(),
    label: String(label || '').trim(),
    command: String(command || '').trim(),
    args: Array.isArray(args) ? args.map((arg) => String(arg)) : [],
    timeoutMs
  };
}

function buildCaskPlan(cask, label) {
  return {
    id: 'homebrew_cask',
    label: label || `Homebrew 安装 ${cask}`,
    command: 'brew',
    args: ['install', '--cask', String(cask || '').trim()],
    timeoutMs: 30 * 60 * 1000
  };
}

function buildCaskUpdatePlan(cask, label) {
  return {
    id: 'homebrew_cask_update',
    label: label || `Homebrew 更新 ${cask}`,
    command: 'brew',
    args: ['upgrade', '--cask', String(cask || '').trim()],
    timeoutMs: 30 * 60 * 1000
  };
}

function buildCaskUninstallPlan(cask, label) {
  return {
    id: 'homebrew_cask_uninstall',
    label: label || `Homebrew 卸载 ${cask}`,
    command: 'brew',
    args: ['uninstall', '--cask', String(cask || '').trim()],
    timeoutMs: 30 * 60 * 1000
  };
}

function buildBrewFormulaUpdatePlan(formula, label) {
  const name = String(formula || '').trim();
  if (!name) return null;
  return {
    id: 'homebrew_formula_update',
    label: label || `Homebrew 更新 ${name}`,
    command: 'brew',
    args: ['upgrade', name],
    timeoutMs: 30 * 60 * 1000
  };
}

function buildBrewFormulaUninstallPlan(formula, label) {
  const name = String(formula || '').trim();
  if (!name) return null;
  return {
    id: 'homebrew_formula_uninstall',
    label: label || `Homebrew 卸载 ${name}`,
    command: 'brew',
    args: ['uninstall', name],
    timeoutMs: 30 * 60 * 1000
  };
}

function buildWingetPlan(packageId, label) {
  return {
    id: 'winget',
    label: label || `winget 安装 ${packageId}`,
    command: 'winget.exe',
    args: [
      'install', '--id', String(packageId || '').trim(), '--exact',
      '--accept-package-agreements', '--accept-source-agreements'
    ],
    timeoutMs: 30 * 60 * 1000
  };
}

function buildWingetUpdatePlan(packageId, label) {
  return {
    id: 'winget_update',
    label: label || `winget 更新 ${packageId}`,
    command: 'winget.exe',
    args: [
      'upgrade', '--id', String(packageId || '').trim(), '--exact',
      '--accept-package-agreements', '--accept-source-agreements'
    ],
    timeoutMs: 30 * 60 * 1000
  };
}

function buildWingetUninstallPlan(packageId, label) {
  return {
    id: 'winget_uninstall',
    label: label || `winget 卸载 ${packageId}`,
    command: 'winget.exe',
    args: ['uninstall', '--id', String(packageId || '').trim(), '--exact'],
    timeoutMs: 30 * 60 * 1000
  };
}

function buildWindowsRegistryUninstallPlan(displayNames, label, options = {}) {
  const names = (Array.isArray(displayNames) ? displayNames : [displayNames])
    .map((name) => String(name || '').trim())
    .filter(Boolean);
  if (!names.length) return null;
  const nameList = names.map(powershellQuote).join(', ');
  const script = [
    `$names = @(${nameList})`,
    `$roots = @('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*', 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*', 'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*')`,
    '$entry = Get-ItemProperty -Path $roots -ErrorAction SilentlyContinue | Where-Object { $display = [string]$_.DisplayName; $names | Where-Object { $display -eq $_ -or $display -like ("*" + $_ + "*") } } | Select-Object -First 1',
    `if (-not $entry) { throw '未找到已安装应用的卸载注册项' }`,
    '$command = [string]$(if ($entry.QuietUninstallString) { $entry.QuietUninstallString } else { $entry.UninstallString })',
    `if (-not $command) { throw '卸载注册项没有可执行命令' }`,
    `$process = Start-Process -FilePath $env:ComSpec -ArgumentList @('/d', '/s', '/c', $command) -Wait -PassThru`,
    `if ($process.ExitCode -ne 0) { throw ('卸载器退出码: ' + $process.ExitCode) }`
  ].join('; ');
  return buildPowerShellPlan('windows_registered_app_uninstall', label || `卸载 ${names[0]}`, script, options);
}

function buildLinuxPackageUninstallPlan(packageNames, label) {
  const names = (Array.isArray(packageNames) ? packageNames : [packageNames])
    .map((name) => String(name || '').trim())
    .filter((name) => /^[a-z0-9][a-z0-9+._-]*$/i.test(name));
  if (!names.length) return null;
  const quotedNames = names.map(shellQuote).join(' ');
  const script = [
    `for pkg in ${quotedNames}; do`,
    '  if command -v dpkg-query >/dev/null 2>&1 && dpkg-query -W -f="${Status}" "$pkg" 2>/dev/null | grep -q "install ok installed"; then',
    '    if [ "$(id -u)" -eq 0 ]; then apt-get remove -y "$pkg"; else sudo -n apt-get remove -y "$pkg"; fi; exit 0',
    '  fi',
    '  if command -v rpm >/dev/null 2>&1 && rpm -q "$pkg" >/dev/null 2>&1; then',
    '    if command -v dnf >/dev/null 2>&1; then manager=dnf; else manager=yum; fi',
    '    if [ "$(id -u)" -eq 0 ]; then "$manager" remove -y "$pkg"; else sudo -n "$manager" remove -y "$pkg"; fi; exit 0',
    '  fi',
    'done',
    'echo "未找到匹配的系统软件包" >&2',
    'exit 44'
  ].join('\n');
  return buildShellPlan('linux_package_uninstall', label || `卸载 ${names[0]}`, script);
}

function buildManagedPathUninstallPlan({ id, label, files = [], trees = [], options = {} }) {
  return buildManagedPathCleanupPlan({ id, label, files, trees, options });
}

function buildMacDmgInstallPlan({ id, label, url, hosts, appName = '', options = {} }) {
  const officialUrl = assertOfficialUrl(url, hosts);
  const expectedName = String(appName || '').trim();
  const script = [
    'tmp="$(mktemp -t aih-app).dmg"',
    'mount="$(mktemp -d -t aih-mount)"',
    'cleanup() { hdiutil detach "$mount" -force >/dev/null 2>&1 || true; rm -rf "$mount" "$tmp"; }',
    'trap cleanup EXIT',
    `curl -fsSL ${shellQuote(officialUrl)} -o "$tmp"`,
    'hdiutil attach "$tmp" -nobrowse -readonly -mountpoint "$mount" >/dev/null',
    `app="$(find "$mount" -maxdepth 1 -type d -name '*.app' -print -quit)"${expectedName ? `; if [ -z "$app" ] || [ "$(basename "$app")" != ${shellQuote(expectedName)} ]; then app="$(find "$mount" -maxdepth 1 -type d -name ${shellQuote(expectedName)} -print -quit)"; fi` : ''}`,
    'if [ -z "$app" ]; then echo "desktop app bundle not found" >&2; exit 1; fi',
    'mkdir -p "$HOME/Applications"',
    'installed="$HOME/Applications/$(basename "$app")"',
    'ditto "$app" "$installed"',
    // 实际包名由厂商 DMG 决定（例如 Qoder IDE.app），校验不依赖 contract 里的路径猜测。
    `echo "${INSTALLED_PATH_MARKER}$installed"`
  ].join('; ');
  return buildShellPlan(id, label, script);
}

// buildWindowsExecutableLaunchStatements 生成「静默启动 + 退出码校验 + UAC 明确报错」。
// 安装器要求提权时会抛 740；此时不能假装安装完成，必须把可读原因交回作业。
function buildWindowsExecutableLaunchStatements({ file = '$dest', silentArgs = [] } = {}) {
  const args = (Array.isArray(silentArgs) ? silentArgs : []).map((arg) => powershellQuote(arg)).join(', ');
  // 不能用 Start-Process -Wait：它等待的是整棵进程树。Qoder CN 等 Inno 安装器
  // 静默安装后会拉起应用，-Wait 会一直等到用户关闭应用（实测 15 分钟不返回），
  // 安装作业就永远停在 installing。改成只等安装器自身进程。
  const launch = `$process = Start-Process -FilePath ${file}${args ? ` -ArgumentList @(${args})` : ''} -PassThru`;
  // try/catch 必须作为同一条语句拼接：`try { } ; catch { }` 不是合法 PowerShell。
  const guarded = `try { ${launch} } catch { $message = [string]$_.Exception.Message; $native = [int]$_.Exception.NativeErrorCode; if ($native -eq 740 -or $message -match 'elevation|提升|管理员权限|740') { throw ('安装器需要管理员权限，请允许 UAC 提示后重试: ' + $message) }; if ($native -eq 1223 -or $message -match 'canceled|cancelled|取消') { throw ('安装器需要管理员权限，但 UAC 授权被取消，请重试并允许授权: ' + $message) }; throw $_ }`;
  return `${guarded}; if (-not $process) { throw '安装器进程未能启动' }; if (-not $process.WaitForExit(1200000)) { throw '安装器运行超时（20 分钟未退出）' }; $exitCode = [int]$process.ExitCode; if ($exitCode -ne 0 -and $exitCode -ne 3010) { throw ('安装器退出码: ' + $exitCode) }`;
}

// Windows 自带 curl.exe（Win10 1803+）。Windows PowerShell 5.1 的 Invoke-WebRequest
// 下载数百 MB 安装包时会卡死（实测 216MB 卡在 205.9MB 15 分钟不动），curl 同文件
// 4 秒完成；--speed-limit/--speed-time 让停滞连接主动超时并重试。没有 curl 时回落。
function buildWindowsDownloadStatements({ url = '', urlExpression = '', dest = '$dest', label = '安装包' } = {}) {
  const target = String(dest || '$dest');
  const source = urlExpression ? String(urlExpression) : powershellQuote(url);
  // 整个 if/else 必须是单条语句：用 `; ` 拼成 `} ; else {` 在 PowerShell 里会报
  // "else is not recognized"，安装会直接失败（真机实测）。
  const statement = `if ($curl) { & $curl.Source -fL --retry 3 --retry-delay 2 --connect-timeout 30 --speed-limit 1024 --speed-time 60 -o ${target} ${source}; if ($LASTEXITCODE -ne 0) { throw ('${label}下载失败: curl 退出码 ' + $LASTEXITCODE) } } else { Invoke-WebRequest -Uri ${source} -OutFile ${target} -UseBasicParsing }`;
  return [
    '$curl = Get-Command curl.exe -ErrorAction SilentlyContinue',
    statement
  ].join('; ');
}

function buildWindowsExecutableInstallPlan({ id, label, url, hosts, silentArgs = [], options = {} }) {
  const officialUrl = assertOfficialUrl(url, hosts);
  const script = [
    `$dest = Join-Path $env:TEMP ('aih-app-' + [guid]::NewGuid().ToString('n') + '.exe')`,
    buildWindowsDownloadStatements({ url: officialUrl }),
    `try { ${buildWindowsExecutableLaunchStatements({ file: '$dest', silentArgs })} } finally { Remove-Item -Force $dest -ErrorAction SilentlyContinue }`
  ].join('; ');
  return buildPowerShellPlan(id, label, script, options);
}

function buildLinuxPackageInstallPlan({ id, label, url, hosts, packageType = 'deb' }) {
  const officialUrl = assertOfficialUrl(url, hosts);
  const suffix = packageType === 'rpm' ? '.rpm' : '.deb';
  const install = packageType === 'rpm'
    ? 'if [ "$(id -u)" -eq 0 ]; then rpm -Uvh "$tmp"; else sudo -n rpm -Uvh "$tmp"; fi'
    : 'if [ "$(id -u)" -eq 0 ]; then apt-get install -y "$tmp"; else sudo -n apt-get install -y "$tmp"; fi';
  const script = [
    `tmp="$(mktemp --suffix=${suffix} aih-app.XXXXXX)"`,
    'trap \'rm -f "$tmp"\' EXIT',
    `curl -fsSL ${shellQuote(officialUrl)} -o "$tmp"`,
    install
  ].join('; ');
  return buildShellPlan(id, label, script);
}

function buildLinuxArchiveInstallPlan({ id, label, url, hosts, provider, executable = '' }) {
  const officialUrl = assertOfficialUrl(url, hosts);
  const safeProvider = String(provider || '').replace(/[^a-z0-9._-]/gi, '-').toLowerCase();
  const safeExecutable = String(executable || '').replace(/[^a-z0-9._-]/gi, '');
  const script = [
    `root="$HOME/.local/opt/${safeProvider}"`,
    'tmp="$(mktemp --suffix=.archive aih-app.XXXXXX)"',
    'trap \'rm -f "$tmp"\' EXIT',
    'mkdir -p "$root" "$HOME/.local/bin"',
    `curl -fsSL ${shellQuote(officialUrl)} -o "$tmp"`,
    'case "$tmp" in *.zip) unzip -oq "$tmp" -d "$root" ;; *) tar -xzf "$tmp" -C "$root" ;; esac',
    safeExecutable ? `candidate="$(find "$root" -type f -name ${shellQuote(safeExecutable)} -perm -u+x -print -quit)"; if [ -n "$candidate" ]; then ln -sf "$candidate" "$HOME/.local/bin/${safeExecutable}"; fi` : ''
  ].filter(Boolean).join('; ');
  return buildShellPlan(id, label, script);
}

module.exports = {
  WINDOWS_INNO_SILENT_ARGS,
  WINDOWS_NSIS_SILENT_ARGS,
  INSTALLED_PATH_MARKER,
  buildWindowsExecutableLaunchStatements,
  buildWindowsDownloadStatements,
  assertOfficialUrl,
  normalizePlatform,
  buildShellPlan,
  buildPowerShellPlan,
  buildPosixScriptPlan,
  buildPowerShellScriptPlan,
  buildCmdScriptPlan,
  buildNpmPlan,
  buildNpmUpdatePlan,
  buildNpmUninstallPlan,
  buildNpmIsolationArgs,
  withNpmIsolation,
  buildCommandPlan,
  buildCaskPlan,
  buildCaskUpdatePlan,
  buildCaskUninstallPlan,
  buildBrewFormulaUpdatePlan,
  buildBrewFormulaUninstallPlan,
  buildWingetPlan,
  buildWingetUpdatePlan,
  buildWingetUninstallPlan,
  buildWindowsRegistryUninstallPlan,
  buildLinuxPackageUninstallPlan,
  buildManagedPathUninstallPlan,
  buildMacDmgInstallPlan,
  buildWindowsExecutableInstallPlan,
  buildLinuxPackageInstallPlan,
  buildLinuxArchiveInstallPlan,
  shellQuote,
  powershellQuote
};
