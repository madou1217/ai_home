'use strict';

const { CLIENT_PLATFORMS } = require('../client-platform');
const { buildClientTerminalLifecyclePlans } = require('../client-terminal-lifecycle');
const { defineClientTerminalAdapter } = require('./adapter');
const { TERMINAL_IDS } = require('./constants');
const { resolveLifecycleExecutable, resolveTerminalExecutable } = require('./shared');

let adapter;
adapter = defineClientTerminalAdapter({
  id: TERMINAL_IDS.WINDOWS_TERMINAL,
  name: 'Windows Terminal',
  description: 'Windows 官方终端宿主，支持 PowerShell、CMD 与 WSL。',
  sourceUrl: 'https://learn.microsoft.com/en-us/windows/terminal/install',
  platforms: {
    windows: {
      binaryNames: ['wt.exe', 'wt'],
      paths: ['{hostHomeDir}/AppData/Local/Microsoft/WindowsApps/wt.exe']
    }
  },
  supports: (platform) => platform === CLIENT_PLATFORMS.WINDOWS,
  detect: (context) => {
    const executablePath = resolveTerminalExecutable(adapter, context);
    return { installed: Boolean(executablePath), executablePath };
  },
  buildLaunch: (command, title, context = {}) => {
    const executable = resolveTerminalExecutable(adapter, context);
    if (!executable) return null;
    // `-w new` 强制独立窗口；windowsHide=false 避免 CREATE_NO_WINDOW 隐藏 GUI。
    return {
      terminalId: TERMINAL_IDS.WINDOWS_TERMINAL,
      file: executable,
      args: ['-w', 'new', 'new-tab', '--title', title, 'cmd.exe', '/k', command],
      windowsHide: false
    };
  },
  buildPlans: (context) => buildClientTerminalLifecyclePlans(
    TERMINAL_IDS.WINDOWS_TERMINAL,
    context,
    { resolveExecutable: resolveLifecycleExecutable }
  )
});

module.exports = adapter;
