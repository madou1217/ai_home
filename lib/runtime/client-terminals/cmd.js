'use strict';

const { CLIENT_PLATFORMS } = require('../client-platform');
const { buildWindowsCmdLaunch } = require('../windows-cmd-launch');

// 经典 conhost 控制台窗口跑整条命令链；引号转义知识统一封装在 windows-cmd-launch。
const cmd = {
  id: 'cmd',
  capability: 'toolkit.terminal',
  name: 'CMD',
  description: 'Windows 经典控制台（conhost）窗口，无需安装。',
  sourceUrl: '',
  platforms: [CLIENT_PLATFORMS.WINDOWS],
  windowsOrder: 1,
  // Windows Terminal 未安装时由 CMD 承担默认终端。
  windowsFallbackDefault: true,
  detect: () => ({ installed: true, executablePath: 'cmd.exe' }),
  buildLaunch(command, title) {
    return {
      terminalId: cmd.id,
      ...buildWindowsCmdLaunch(command, { newConsole: true, title })
    };
  }
};

module.exports = cmd;
