'use strict';

const { buildPackagePlans } = require('./package-plans');
const { buildOfficialShellPlans, shellQuote } = require('./shared');

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

function resolveBrew(context, dependencies) {
  const homeDir = String(context.hostHomeDir || context.env && context.env.HOME || '').trim();
  const fallbackPaths = [
    '/opt/homebrew/bin/brew',
    '/usr/local/bin/brew',
    homeDir && context.path ? context.path.join(homeDir, '.homebrew', 'bin', 'brew') : ''
  ].filter(Boolean);
  return dependencies.resolveExecutable(['brew'], fallbackPaths, context);
}

/**
 * macOS 终端插件的标准生命周期：有 Homebrew 用 Homebrew，否则走插件给出的官方安装脚本。
 */
function homebrewOrOfficial(terminalPackage, buildOfficialPlans) {
  return (context = {}, dependencies = {}) => {
    if (typeof dependencies.resolveExecutable !== 'function') return [];
    const executable = resolveBrew(context, dependencies);
    const packagePlans = buildPackagePlans({ id: 'homebrew', executable }, terminalPackage.packageId, terminalPackage.label);
    return packagePlans.length ? packagePlans : buildOfficialPlans(context);
  };
}

module.exports = {
  appTarget,
  buildOfficialShellPlans,
  dmgInstallScript,
  homebrewOrOfficial,
  shellQuote,
  uninstallAppBundleScript,
  zipInstallScript
};
