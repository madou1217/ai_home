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
  id: TERMINAL_IDS.WARP,
  name: 'Warp',
  description: '跨平台现代终端，支持 macOS、Windows 与 Linux。',
  sourceUrl: 'https://www.warp.dev/terminal',
  platforms: {
    macos: {
      binaryNames: [],
      managedPaths: ['{hostHomeDir}/Applications/Warp.app/Contents/MacOS/stable'],
      paths: ['/Applications/Warp.app/Contents/MacOS/stable']
    },
    windows: {
      binaryNames: ['warp.exe', 'Warp.exe'],
      managedPaths: ['{localAppData}/Programs/Warp/Warp.exe'],
      paths: ['{hostHomeDir}/AppData/Local/Programs/Warp/Warp.exe']
    },
    linux: {
      binaryNames: ['warp-terminal'],
      managedPaths: ['{hostHomeDir}/.local/bin/warp-terminal'],
      paths: ['/usr/bin/warp-terminal', '/usr/local/bin/warp-terminal']
    }
  },
  supports: () => true,
  detect: (context) => {
    const executablePath = resolveTerminalExecutable(adapter, context);
    return { installed: Boolean(executablePath), executablePath };
  },
  buildLaunch: (_command, title, context = {}) => {
    const resolved = resolveContext(context);
    const executable = resolveTerminalExecutable(adapter, resolved);
    if (!executable) return null;
    if (resolved.platform === CLIENT_PLATFORMS.MACOS) {
      return {
        terminalId: TERMINAL_IDS.WARP,
        file: '/usr/bin/open',
        args: ['-n', '-a', 'Warp'],
        title
      };
    }
    return { terminalId: TERMINAL_IDS.WARP, file: executable, args: [], title };
  },
  buildPlans: (context) => buildClientTerminalLifecyclePlans(
    TERMINAL_IDS.WARP,
    context,
    { resolveExecutable: resolveLifecycleExecutable }
  )
});

module.exports = adapter;
