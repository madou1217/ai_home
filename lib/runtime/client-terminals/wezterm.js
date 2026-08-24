'use strict';

const { CLIENT_PLATFORMS } = require('../client-platform');
const { buildClientTerminalLifecyclePlans } = require('../client-terminal-lifecycle');
const { defineClientTerminalAdapter } = require('./adapter');
const { TERMINAL_IDS } = require('./constants');
const {
  resolveContext,
  resolveLifecycleExecutable,
  resolveTerminalExecutable
} = require('./shared');

let adapter;
adapter = defineClientTerminalAdapter({
  id: TERMINAL_IDS.WEZTERM,
  name: 'WezTerm',
  description: '跨平台 GPU 终端，支持 macOS、Windows 与 Linux。',
  sourceUrl: 'https://wezterm.org/install/',
  platforms: {
    macos: {
      binaryNames: ['wezterm', 'wezterm-gui'],
      managedPaths: ['{hostHomeDir}/Applications/WezTerm.app/Contents/MacOS/wezterm'],
      paths: ['/Applications/WezTerm.app/Contents/MacOS/wezterm']
    },
    windows: {
      binaryNames: ['wezterm.exe', 'wezterm-gui.exe'],
      managedPaths: ['{localAppData}/Programs/WezTerm/wezterm.exe'],
      paths: ['{hostHomeDir}/scoop/apps/wezterm/current/wezterm.exe']
    },
    linux: {
      binaryNames: ['wezterm', 'wezterm-gui'],
      managedPaths: ['{hostHomeDir}/.local/bin/wezterm'],
      paths: ['/usr/bin/wezterm', '/usr/local/bin/wezterm']
    }
  },
  supports: () => true,
  detect: (context) => {
    const executablePath = resolveTerminalExecutable(adapter, context);
    return { installed: Boolean(executablePath), executablePath };
  },
  buildLaunch: (command, title, context = {}) => {
    const resolved = resolveContext(context);
    const executable = resolveTerminalExecutable(adapter, resolved);
    if (!executable) return null;
    if (resolved.platform === CLIENT_PLATFORMS.WINDOWS) {
      return {
        terminalId: TERMINAL_IDS.WEZTERM,
        file: executable,
        args: ['start', '--always-new-process', '--', 'cmd.exe', '/k', command]
      };
    }
    return {
      terminalId: TERMINAL_IDS.WEZTERM,
      file: executable,
      args: ['start', '--always-new-process', '--', 'bash', '-lc', command],
      title
    };
  },
  buildPlans: (context) => buildClientTerminalLifecyclePlans(
    TERMINAL_IDS.WEZTERM,
    context,
    { resolveExecutable: resolveLifecycleExecutable }
  )
});

module.exports = adapter;
