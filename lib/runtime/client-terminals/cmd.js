'use strict';

const { CLIENT_PLATFORMS } = require('../client-platform');
const { buildWindowsCmdLaunch } = require('../windows-cmd-launch');
const { defineClientTerminalAdapter } = require('./adapter');
const { TERMINAL_IDS } = require('./constants');

module.exports = defineClientTerminalAdapter({
  id: TERMINAL_IDS.CMD,
  name: 'CMD',
  description: 'Windows 经典控制台（conhost）窗口，无需安装。',
  sourceUrl: '',
  platforms: { windows: { binaryNames: [], paths: [] } },
  supports: (platform) => platform === CLIENT_PLATFORMS.WINDOWS,
  detect: () => ({ installed: true, executablePath: 'cmd.exe' }),
  buildLaunch: (command, title) => ({
    terminalId: TERMINAL_IDS.CMD,
    ...buildWindowsCmdLaunch(command, { newConsole: true, title })
  }),
  buildPlans: () => []
});
