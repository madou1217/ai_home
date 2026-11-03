'use strict';

const { buildOfficialShellPlans, shellQuote } = require('./shared');

function homeDir(context = {}) {
  return String(context.hostHomeDir || context.env && context.env.HOME || '').trim();
}

function managedExecutablePath(executableName, context = {}) {
  const home = homeDir(context);
  return home && context.path
    ? context.path.join(home, '.local', 'bin', executableName)
    : '';
}

function buildInstallScript({ executableName, resolveUrlScript, context }) {
  const targetPath = managedExecutablePath(executableName, context);
  const targetAssignment = targetPath
    ? `target=${shellQuote(targetPath)}`
    : `target="$HOME/.local/bin/${executableName}"`;
  return [
    'tmp="$(mktemp -t aih-terminal.XXXXXX)"',
    'trap \'rm -f "$tmp"\' EXIT',
    resolveUrlScript,
    'curl -fsSL "$url" -o "$tmp"',
    'chmod 0755 "$tmp"',
    targetAssignment,
    'mkdir -p "$(dirname "$target")"',
    'install -m 0755 "$tmp" "$target"'
  ].join('\n');
}

function buildUninstallScript({ executableName, packageNames = [], context = {} }) {
  const managedPath = managedExecutablePath(executableName, context);
  const installedPath = String(context.installedPath || '').trim();
  const packages = packageNames.map(shellQuote).join(' ');
  const targets = Array.from(new Set([managedPath, installedPath].filter(Boolean)))
    .map(shellQuote)
    .join(' ');
  return [
    'export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin${PATH:+:$PATH}"',
    'run_root() {',
    '  if [ "$(id -u)" -eq 0 ]; then "$@"; return; fi',
    '  if command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then sudo -n "$@"; return; fi',
    '  if command -v pkexec >/dev/null 2>&1; then pkexec "$@"; return; fi',
    '  echo "需要管理员权限才能移除系统终端" >&2',
    '  exit 77',
    '}',
    `for package_name in ${packages || "''"}; do`,
    '  if command -v dpkg-query >/dev/null 2>&1 && dpkg-query -W -f="${Status}" "$package_name" 2>/dev/null | grep -q "install ok installed"; then',
    '    if command -v apt-get >/dev/null 2>&1; then run_root apt-get remove -y "$package_name"; else run_root dpkg --remove "$package_name"; fi',
    '  fi',
    '  if command -v rpm >/dev/null 2>&1 && rpm -q "$package_name" >/dev/null 2>&1; then',
    '    if command -v dnf >/dev/null 2>&1; then run_root dnf remove -y "$package_name";',
    '    elif command -v yum >/dev/null 2>&1; then run_root yum remove -y "$package_name";',
    '    else run_root rpm -e "$package_name"; fi',
    '  fi',
    'done',
    `for target in ${targets || "''"}; do`,
    '  if [ -z "$target" ] || [ ! -e "$target" ] && [ ! -L "$target" ]; then continue; fi',
    '  case "$target" in',
    `    */.local/bin/${executableName}) rm -f "$target" ;;`,
    `    /usr/bin/${executableName}|/usr/local/bin/${executableName}) run_root rm -f "$target" ;;`,
    '    *) echo "拒绝移除非受管终端路径: $target" >&2; exit 64 ;;',
    '  esac',
    'done'
  ].join('\n');
}

function buildLinuxAppImagePlans(options = {}) {
  const installScript = buildInstallScript(options);
  return buildOfficialShellPlans(options.label, {
    install: installScript,
    update: installScript,
    uninstall: buildUninstallScript(options)
  });
}

module.exports = {
  buildLinuxAppImagePlans
};
