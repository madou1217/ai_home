'use strict';

// 共享的安装计划构造器只负责跨平台命令骨架和 URL 安全校验，不保存任何
// Provider 名单或来源。每个 provider 文件仍必须声明自己的官方 URL、包名和
// 安装方式，从而新增 Provider 只增加一个独立模块。
const {
  CLIENT_PLATFORMS,
  getClientPlatformAdapter,
  resolveClientPlatform
} = require('../../runtime/client-platform');

function normalizePlatform(options = {}) {
  return resolveClientPlatform(options);
}

const NPM_PUBLIC_REGISTRY = 'https://registry.npmjs.org';

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
    args: ['-lc', `set -euo pipefail; ${String(script || '').trim()}`],
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
    'ditto "$app" "$HOME/Applications/$(basename "$app")"'
  ].join('; ');
  return buildShellPlan(id, label, script);
}

function buildWindowsExecutableInstallPlan({ id, label, url, hosts, silentArgs = [], options = {} }) {
  const officialUrl = assertOfficialUrl(url, hosts);
  const args = (Array.isArray(silentArgs) ? silentArgs : []).map((arg) => powershellQuote(arg)).join(', ');
  const script = [
    `$dest = Join-Path $env:TEMP ('aih-app-' + [guid]::NewGuid().ToString('n') + '.exe')`,
    `Invoke-WebRequest -Uri ${powershellQuote(officialUrl)} -OutFile $dest -UseBasicParsing`,
    `try { Start-Process -FilePath $dest${args ? ` -ArgumentList @(${args})` : ''} -Wait } finally { Remove-Item -Force $dest -ErrorAction SilentlyContinue }`
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
  buildWingetPlan,
  buildWingetUpdatePlan,
  buildWingetUninstallPlan,
  buildMacDmgInstallPlan,
  buildWindowsExecutableInstallPlan,
  buildLinuxPackageInstallPlan,
  buildLinuxArchiveInstallPlan,
  shellQuote,
  powershellQuote
};
