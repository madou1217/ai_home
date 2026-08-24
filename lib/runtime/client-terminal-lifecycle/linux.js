'use strict';

const { buildPackagePlans } = require('./package-plans');
const { buildLinuxAppImagePlans } = require('./linux-appimage');
const { shellQuote } = require('./shared');
const { buildWarpLinuxPlans } = require('./warp-linux');

const WEZTERM_RELEASE_API = 'https://api.github.com/repos/wezterm/wezterm/releases/latest';

function buildWezTermOfficialPlans(context = {}) {
  return buildLinuxAppImagePlans({
    label: 'WezTerm',
    executableName: 'wezterm',
    packageNames: ['wezterm'],
    context,
    resolveUrlScript: [
      `release="$(curl -fsSL ${shellQuote(WEZTERM_RELEASE_API)})"`,
      'url="$(printf \'%s\\n\' "$release" | grep -Eo \'https://github.com/wezterm/wezterm/releases/download/[^" ]+/WezTerm-[^" ]+-Ubuntu20\\.04\\.AppImage\' | head -n1)"',
      'case "$url" in https://github.com/wezterm/wezterm/releases/download/*/WezTerm-*-Ubuntu20.04.AppImage) ;; *) echo "未找到 WezTerm 官方 AppImage" >&2; exit 1;; esac'
    ].join('\n')
  });
}

function buildLinuxTerminalPlans(terminalId, context = {}, dependencies = {}) {
  if (terminalId === 'warp') return buildWarpLinuxPlans(context, dependencies);
  if (terminalId !== 'wezterm' || typeof dependencies.resolveExecutable !== 'function') return [];
  const homeDir = String(context.hostHomeDir || context.env && context.env.HOME || '').trim();
  const fallbackPaths = [
    '/usr/bin/flatpak',
    '/usr/local/bin/flatpak',
    homeDir && context.path ? context.path.join(homeDir, '.local', 'bin', 'flatpak') : ''
  ].filter(Boolean);
  const executable = dependencies.resolveExecutable(['flatpak'], fallbackPaths, context);
  const packagePlans = buildPackagePlans(
    { id: 'flatpak', executable },
    'org.wezfurlong.wezterm',
    'WezTerm'
  );
  return packagePlans.length ? packagePlans : buildWezTermOfficialPlans(context);
}

module.exports = {
  buildLinuxTerminalPlans
};
