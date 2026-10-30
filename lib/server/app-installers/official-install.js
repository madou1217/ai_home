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
const { buildWindowsCmdLaunch } = require('../../runtime/windows-cmd-launch');
const {
  powershellQuote,
  buildWindowsDownloadStatements,
  buildWindowsExecutableLaunchStatements
} = require('../../runtime/windows-install-script');

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

/**
 * 网络韧性参数（与隔离参数分开，便于测试与解释）。
 *
 * 实测（2026-10-30）：toolkit 里 dsh / qodercli / opencode 三个安装作业同时跑，三个
 * npm 进程都是 CPU 0%、到 registry.npmjs.org 的 ESTABLISHED 连接 **0 字节**、缓存
 * 0 增长 —— 不是「下载慢」，是连接挂住。npm 默认 `fetch-timeout` 是 5 分钟、
 * `fetch-retries` 2 次且退避是 10s→100s，于是几十个包排在一个挂住的 socket 后面，
 * 作业在 20 分钟超时前一直显示 installing（用户看到的「非常慢」）。
 *
 * 这里只调网络参数：单次请求 60s 就放弃重试、退避封顶 20s，让 npm 尽快换连接；
 * audit/fund 是纯额外请求，安装场景直接关掉。
 */
function buildNpmNetworkArgs() {
  return [
    // 16 路并发实测（2026-10-30，registry.npmjs.org 走本机 TUN 代理 198.18.0.1）：
    // 14/16 个连接 4–7s 内跑完（约 900KB/s），2/16 个连接**完全不动**（40s 0 字节），
    // 还有一个只跑到 341 B/s。也就是说单个新连接有 ~12% 概率挂死，与带宽无关。
    // npm 默认 maxsockets=15，一次并发十几条连接，几乎必然踩中一条挂死的；
    // 而它要等满 fetch-timeout（默认 5 分钟）才重试，于是整台机器看起来「装不动」。
    // 实测把并发压到 2，同一次冷安装能一路跑完；4 是速度与挂死概率的折中值。
    '--maxsockets=4',
    '--fetch-timeout=60000',
    '--fetch-retries=3',
    '--fetch-retry-mintimeout=5000',
    '--fetch-retry-maxtimeout=20000',
    '--no-audit',
    '--no-fund'
  ];
}

function withNpmIsolation(args, options = {}) {
  const baseArgs = Array.isArray(args) ? args.map((arg) => String(arg)) : [];
  const withoutOverrides = baseArgs.filter((arg) => !/^--(?:userconfig|registry)(?:=|$)/i.test(arg));
  return withoutOverrides.concat(buildNpmIsolationArgs(options), buildNpmNetworkArgs());
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

// scriptArgs：官方安装脚本的**参数**（不是 curl 的参数）。某些安装器默认会改写用户的
// shell 配置（opencode v2 会往 ~/.zshrc / config.fish 追加 PATH），而从常驻 server 里跑的
// 安装作业不该顺手改用户的 rc 文件 —— 这类副作用必须由调用方显式关掉。
function buildPosixScriptPlan({ id, label, url, hosts, options = {}, scriptArgs = [] }) {
  const officialUrl = assertOfficialUrl(url, hosts);
  const home = String(options.hostHomeDir || '').trim();
  const tempDir = home ? `${shellQuote(require('node:path').posix.join(home, '.cache', 'ai-home-installs'))}` : '"${TMPDIR:-/tmp}"';
  const forwardedArgs = (Array.isArray(scriptArgs) ? scriptArgs : [])
    .map((arg) => shellQuote(arg))
    .join(' ');
  const script = [
    `tmp_dir=${tempDir}`,
    'mkdir -p "$tmp_dir"',
    'script="$tmp_dir/aih-installer-$$.sh"',
    'trap \'rm -f "$script"\' EXIT',
    `curl --compressed -fsSL ${shellQuote(officialUrl)} -o "$script"`,
    forwardedArgs ? `bash "$script" ${forwardedArgs}` : 'bash "$script"'
  ].join('; ');
  return buildShellPlan(id, label, script);
}

function buildPowerShellScriptPlan({ id, label, url, hosts, options = {} }) {
  const officialUrl = assertOfficialUrl(url, hosts);
  // 不要先把安装脚本落到 %TEMP% 再执行：第三方安全软件（实测火绒 sysdiag 过滤驱动）
  // 会把刚下载的 .ps1 判成风险文件，导致读取/执行时报 Access denied 并删除文件。
  // 官方脚本都很小（几 KB），直接在内存里解码执行，既绕过文件隔离，也不留临时文件。
  // 脚本若引用 $MyInvocation/PSCommandPath，按 PowerShell 的 sourced 语义自行处理。
  const script = [
    `$response = Invoke-WebRequest -Uri ${powershellQuote(officialUrl)} -UseBasicParsing`,
    '$content = $response.Content',
    'if ($content -is [byte[]]) { $text = [System.Text.Encoding]::UTF8.GetString($content) } else { $text = [string]$content }',
    '& ([scriptblock]::Create($text))'
  ].join('; ');
  return buildPowerShellPlan(id, label, script, options);
}

function buildCmdScriptPlan({ id, label, url, hosts, options = {} }) {
  const officialUrl = assertOfficialUrl(url, hosts);
  // 不要用 set 变量再 call "%dest%"：cmd 在整条 /c 命令串里对变量的展开时机
  // 不可靠（真机实测会退化成把带引号的路径当命令执行，报 not recognized）。
  // 文件名按计划 id 固定且直接写成字面量 %TEMP%\...，每个位置展开结果一致。
  // 同一 Provider 的安装作业由 job manager 串行化，不会自我竞争。
  const suffix = String(id || 'install').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
  const dest = `%TEMP%\\aih-installer-${suffix || 'install'}.cmd`;
  const script = [
    `curl.exe -fsSL "${officialUrl}" -o "${dest}"`,
    `call "${dest}"`,
    `del /f /q "${dest}"`
  ].join(' && ');
  // cmd.exe 的命令串必须用 windowsVerbatimArguments 交给 spawn：libuv 默认会把
  // 内部引号转义成 \"，cmd 不认，curl 收到的 URL 会变成带引号的串并报
  // "Port number was not a decimal number"（真机实测）。命令串格式的唯一
  // 事实源是 buildWindowsCmdLaunch。
  const launch = buildWindowsCmdLaunch(script);
  return {
    id: String(id || '').trim(),
    label: String(label || '').trim(),
    command: launch.file,
    args: launch.args,
    windowsVerbatimArguments: launch.windowsVerbatimArguments,
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

// winget 用 0x8A15002B 表示「已安装且没有可用更新」：对「确保安装」类计划来说
// 这已经是目标状态，不能当失败。该值在 JavaScript 里可能是正数或负数两种符号。
const WINGET_NO_APPLICABLE_UPDATE_EXIT_CODES = [2316632107, -1978335189];

function buildWingetPlan(packageId, label, options = {}) {
  const source = String(options.source || '').trim();
  const args = [
    'install', '--id', String(packageId || '').trim(), '--exact'
  ];
  if (source) args.push('--source', source);
  args.push('--accept-package-agreements', '--accept-source-agreements');
  return {
    id: 'winget',
    label: label || `winget 安装 ${packageId}`,
    command: 'winget.exe',
    args,
    successExitCodes: [...WINGET_NO_APPLICABLE_UPDATE_EXIT_CODES],
    timeoutMs: 30 * 60 * 1000
  };
}

function buildWingetUpdatePlan(packageId, label, options = {}) {
  const source = String(options.source || '').trim();
  const args = [
    'upgrade', '--id', String(packageId || '').trim(), '--exact'
  ];
  if (source) args.push('--source', source);
  args.push('--accept-package-agreements', '--accept-source-agreements');
  return {
    id: 'winget_update',
    label: label || `winget 更新 ${packageId}`,
    command: 'winget.exe',
    args,
    // 「没有可用更新」对更新流程同样是成功，否则每次刷新都报错。
    successExitCodes: [...WINGET_NO_APPLICABLE_UPDATE_EXIT_CODES],
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
    `$process = Start-Process -FilePath $env:ComSpec -ArgumentList @('/d', '/s', '/c', $command) -PassThru`,
    `if (-not $process.WaitForExit(600000)) { throw '卸载器运行超时（10 分钟未退出）' }`,
    `if ($process.ExitCode -ne 0 -and $process.ExitCode -ne 3010) { throw ('卸载器退出码: ' + $process.ExitCode) }`
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
  buildNpmNetworkArgs,
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
