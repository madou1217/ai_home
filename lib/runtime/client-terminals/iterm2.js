'use strict';

const { CLIENT_PLATFORMS } = require('../client-platform');
const {
  escapeAppleScriptString,
  findFirstExisting,
  readHostHome,
  resolveContext
} = require('../client-terminal-support');
const {
  appTarget,
  buildOfficialShellPlans,
  homebrewOrOfficial,
  shellQuote,
  uninstallAppBundleScript,
  zipInstallScript
} = require('../client-terminal-lifecycle/macos');

const ITERM_DOWNLOADS_PAGE = 'https://iterm2.com/downloads.html';

function macosOfficialPlans(context = {}) {
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

const iterm2 = {
  id: 'iterm2',
  capability: 'toolkit.terminal',
  name: 'iTerm2',
  description: 'macOS 常用终端，适合多窗口和多会话开发。',
  sourceUrl: 'https://iterm2.com/documentation.html',
  platforms: [CLIENT_PLATFORMS.MACOS],
  detect(context) {
    const resolved = resolveContext(context);
    const appPath = findFirstExisting([
      `${readHostHome(resolved)}/Applications/iTerm.app`,
      '/Applications/iTerm.app'
    ], resolved.fs);
    return { installed: Boolean(appPath), executablePath: appPath };
  },
  buildLaunch(command, title, context = {}) {
    const detection = iterm2.detect(resolveContext(context));
    if (!detection || !detection.installed) return null;
    const script = [
      'tell application "iTerm2"',
      'activate',
      'tell current window',
      'create tab with default profile',
      `tell current session to write text "${escapeAppleScriptString(command)}"`,
      'end tell',
      'end tell'
    ];
    return {
      terminalId: iterm2.id,
      file: 'osascript',
      args: script.flatMap((line) => ['-e', line]),
      title
    };
  },
  lifecycle: {
    macos: homebrewOrOfficial({ packageId: 'iterm2', label: 'iTerm2' }, macosOfficialPlans)
  }
};

module.exports = iterm2;
