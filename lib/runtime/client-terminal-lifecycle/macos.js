'use strict';

const {
  CLIENT_ARCHITECTURES,
  resolveClientArchitecture
} = require('../client-platform');
const { buildPackagePlans } = require('./package-plans');
const { buildOfficialShellPlans, shellQuote } = require('./shared');

const TERMINAL_PACKAGES = Object.freeze({
  wezterm: Object.freeze({ packageId: 'wezterm', label: 'WezTerm' }),
  warp: Object.freeze({ packageId: 'warp', label: 'Warp' }),
  iterm2: Object.freeze({ packageId: 'iterm2', label: 'iTerm2' })
});

const WEZTERM_RELEASE_API = 'https://api.github.com/repos/wezterm/wezterm/releases/latest';
const ITERM_DOWNLOADS_PAGE = 'https://iterm2.com/downloads.html';

function appTarget(appName, context = {}) {
  const pathImpl = context.path;
  const homeDir = String(context.hostHomeDir || context.env && context.env.HOME || '').trim();
  const systemTarget = pathImpl.join('/Applications', appName);
  const userTarget = homeDir ? pathImpl.join(homeDir, 'Applications', appName) : systemTarget;
  const installedPath = String(context.installedPath || '').trim();
  const normalizedInstalledPath = installedPath ? pathImpl.normalize(installedPath) : '';
  for (const target of [userTarget, systemTarget]) {
    const normalizedTarget = pathImpl.normalize(target);
    if (normalizedInstalledPath === normalizedTarget
      || normalizedInstalledPath.startsWith(`${normalizedTarget}${pathImpl.sep}`)) {
      return target;
    }
  }
  return userTarget;
}

function installAppBundleScript(target, appName) {
  return [
    `app="$(find "$source_root" -type d -name ${shellQuote(appName)} -print -quit)"`,
    'if [ -z "$app" ]; then echo "官方安装包中未找到应用" >&2; exit 1; fi',
    `target=${shellQuote(target)}`,
    'parent="$(dirname "$target")"',
    'mkdir -p "$parent" 2>/dev/null || true',
    'if [ -w "$parent" ] && { [ ! -e "$target" ] || [ -w "$target" ]; }; then',
    '  rm -rf "$target"',
    '  /usr/bin/ditto "$app" "$target"',
    'else',
    '  /usr/bin/osascript - "$target" "$app" <<\'APPLESCRIPT\'',
    'on run argv',
    '  set targetPath to item 1 of argv',
    '  set sourcePath to item 2 of argv',
    '  set commandText to "/bin/rm -rf " & quoted form of targetPath & " && /usr/bin/ditto " & quoted form of sourcePath & " " & quoted form of targetPath',
    '  do shell script commandText with administrator privileges',
    'end run',
    'APPLESCRIPT',
    'fi'
  ].join('\n');
}

function uninstallAppBundleScript(target) {
  return [
    `target=${shellQuote(target)}`,
    'if [ ! -e "$target" ]; then exit 0; fi',
    'parent="$(dirname "$target")"',
    'if [ -w "$parent" ] && [ -w "$target" ]; then',
    '  rm -rf "$target"',
    'else',
    '  /usr/bin/osascript - "$target" <<\'APPLESCRIPT\'',
    'on run argv',
    '  set targetPath to item 1 of argv',
    '  do shell script "/bin/rm -rf " & quoted form of targetPath with administrator privileges',
    'end run',
    'APPLESCRIPT',
    'fi'
  ].join('\n');
}

function zipInstallScript(resolveUrlScript, target, appName) {
  return [
    'tmp_dir="$(mktemp -d -t aih-terminal.XXXXXX)"',
    'trap \'rm -rf "$tmp_dir"\' EXIT',
    resolveUrlScript,
    'archive="$tmp_dir/app.zip"',
    'source_root="$tmp_dir/unpack"',
    'mkdir -p "$source_root"',
    'curl -fsSL "$url" -o "$archive"',
    '/usr/bin/ditto -x -k "$archive" "$source_root"',
    installAppBundleScript(target, appName)
  ].join('\n');
}

function dmgInstallScript(url, target, appName) {
  return [
    'tmp_dir="$(mktemp -d -t aih-terminal.XXXXXX)"',
    'mount="$tmp_dir/mount"',
    'mkdir -p "$mount"',
    'cleanup() { /usr/bin/hdiutil detach "$mount" -force >/dev/null 2>&1 || true; rm -rf "$tmp_dir"; }',
    'trap cleanup EXIT',
    `url=${shellQuote(url)}`,
    'archive="$tmp_dir/app.dmg"',
    'source_root="$mount"',
    'curl -fsSL "$url" -o "$archive"',
    '/usr/bin/hdiutil attach "$archive" -nobrowse -readonly -mountpoint "$mount" >/dev/null',
    installAppBundleScript(target, appName)
  ].join('\n');
}

function buildOfficialPlans(terminalId, context = {}) {
  if (terminalId === 'wezterm') {
    const target = appTarget('WezTerm.app', context);
    const install = zipInstallScript([
      `release_json="$(curl -fsSL -H 'Accept: application/vnd.github+json' -H 'User-Agent: ai-home-toolkit' ${shellQuote(WEZTERM_RELEASE_API)})"`,
      'url="$(printf \'%s\' "$release_json" | tr \'\\n\' \' \' | sed -n \'s/.*"browser_download_url":[[:space:]]*"\\([^"]*WezTerm-macos-[^"]*\\.zip\\)".*/\\1/p\')"',
      'case "$url" in https://github.com/wezterm/wezterm/releases/download/*/WezTerm-macos-*.zip) ;; *) echo "未解析到 WezTerm 官方 macOS 发布包" >&2; exit 1;; esac'
    ].join('\n'), target, 'WezTerm.app');
    return buildOfficialShellPlans('WezTerm', {
      install,
      update: install,
      uninstall: uninstallAppBundleScript(target)
    });
  }
  if (terminalId === 'warp') {
    const target = appTarget('Warp.app', context);
    const architecture = resolveClientArchitecture(context);
    const packageName = architecture === CLIENT_ARCHITECTURES.ARM64 ? 'dmg_arm64' : 'dmg_x86_64';
    const install = dmgInstallScript(`https://app.warp.dev/download?package=${packageName}`, target, 'Warp.app');
    return buildOfficialShellPlans('Warp', {
      install,
      update: install,
      uninstall: uninstallAppBundleScript(target)
    });
  }
  if (terminalId === 'iterm2') {
    const target = appTarget('iTerm.app', context);
    const install = zipInstallScript([
      `page="$(curl -fsSL ${shellQuote(ITERM_DOWNLOADS_PAGE)})"`,
      'url="$(printf \'%s\' "$page" | grep -Eo \'https://iterm2\\.com/downloads/stable/iTerm2-[0-9_]+\\.zip\' | head -n1)"',
      'case "$url" in https://iterm2.com/downloads/stable/iTerm2-*.zip) ;; *) echo "未解析到 iTerm2 官方稳定版" >&2; exit 1;; esac'
    ].join('\n'), target, 'iTerm.app');
    return buildOfficialShellPlans('iTerm2', {
      install,
      update: install,
      uninstall: uninstallAppBundleScript(target)
    });
  }
  return [];
}

function buildMacosTerminalPlans(terminalId, context = {}, dependencies = {}) {
  const terminalPackage = TERMINAL_PACKAGES[terminalId];
  if (!terminalPackage || typeof dependencies.resolveExecutable !== 'function') return [];
  const homeDir = String(context.hostHomeDir || context.env && context.env.HOME || '').trim();
  const fallbackPaths = [
    '/opt/homebrew/bin/brew',
    '/usr/local/bin/brew',
    homeDir && context.path ? context.path.join(homeDir, '.homebrew', 'bin', 'brew') : ''
  ].filter(Boolean);
  const executable = dependencies.resolveExecutable(['brew'], fallbackPaths, context);
  const packagePlans = buildPackagePlans({ id: 'homebrew', executable }, terminalPackage.packageId, terminalPackage.label);
  return packagePlans.length ? packagePlans : buildOfficialPlans(terminalId, context);
}

module.exports = {
  buildMacosTerminalPlans
};
