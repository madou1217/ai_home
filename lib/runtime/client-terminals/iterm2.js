'use strict';

const { CLIENT_PLATFORMS } = require('../client-platform');
const { buildClientTerminalLifecyclePlans } = require('../client-terminal-lifecycle');
const { defineClientTerminalAdapter } = require('./adapter');
const { TERMINAL_IDS } = require('./constants');
const {
  escapeAppleScriptString,
  findFirstExisting,
  readHostHome,
  resolveContext,
  resolveLifecycleExecutable
} = require('./shared');

let adapter;
adapter = defineClientTerminalAdapter({
  id: TERMINAL_IDS.ITERM2,
  name: 'iTerm2',
  description: 'macOS 常用终端，适合多窗口和多会话开发。',
  sourceUrl: 'https://iterm2.com/documentation.html',
  supports: (platform) => platform === CLIENT_PLATFORMS.MACOS,
  detect: (context) => {
    const resolved = resolveContext(context);
    const appPath = findFirstExisting([
      `${readHostHome(resolved)}/Applications/iTerm.app`,
      '/Applications/iTerm.app'
    ], resolved.fs);
    return { installed: Boolean(appPath), executablePath: appPath };
  },
  buildLaunch: (command, title, context = {}) => {
    const resolved = resolveContext(context);
    const detection = adapter.detect(resolved);
    if (!detection.installed) return null;
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
      terminalId: TERMINAL_IDS.ITERM2,
      file: 'osascript',
      args: script.flatMap((line) => ['-e', line]),
      title
    };
  },
  buildPlans: (context) => buildClientTerminalLifecyclePlans(
    TERMINAL_IDS.ITERM2,
    context,
    { resolveExecutable: resolveLifecycleExecutable }
  )
});

module.exports = adapter;
