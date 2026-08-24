'use strict';

const { CLIENT_PLATFORMS } = require('../client-platform');
const { buildWindowsCmdLaunch } = require('../windows-cmd-launch');
const { defineClientTerminalAdapter } = require('./adapter');
const { DEFAULT_TERMINAL_ID } = require('./constants');
const {
  escapeAppleScriptString,
  findOnPath,
  resolveContext
} = require('./shared');
const windowsTerminal = require('./windows-terminal');

module.exports = defineClientTerminalAdapter({
  id: DEFAULT_TERMINAL_ID,
  name: '系统默认终端',
  description: '使用当前操作系统配置的默认终端。',
  sourceUrl: '',
  default: true,
  supports: () => true,
  detect: () => ({ installed: true, executablePath: '' }),
  buildLaunch: (command, title, context = {}) => {
    const resolved = resolveContext(context);
    const { env, fs, path, platform } = resolved;
    if (platform === CLIENT_PLATFORMS.WINDOWS) {
      // 隐藏父进程无法依赖系统默认终端 deflection；优先显式委托 WT。
      const wtLaunch = windowsTerminal.buildLaunch(command, title, resolved);
      if (wtLaunch) return wtLaunch;
      return {
        terminalId: DEFAULT_TERMINAL_ID,
        ...buildWindowsCmdLaunch(command, { newConsole: true, title })
      };
    }
    if (platform === CLIENT_PLATFORMS.MACOS) {
      const script = [
        'tell application "Terminal"',
        'activate',
        `do script "${escapeAppleScriptString(command)}"`,
        'end tell'
      ];
      return {
        terminalId: DEFAULT_TERMINAL_ID,
        file: 'osascript',
        args: script.flatMap((line) => ['-e', line])
      };
    }
    if (platform === CLIENT_PLATFORMS.LINUX) {
      const candidates = [];
      const requested = String(env.TERMINAL || '').trim();
      if (requested) candidates.push([requested, '-e']);
      candidates.push(
        ['x-terminal-emulator', '-e'],
        ['gnome-terminal', '--'],
        ['konsole', '-e'],
        ['xfce4-terminal', '-e'],
        ['alacritty', '-e']
      );
      for (const [name, prefix] of candidates) {
        const executable = path.isAbsolute(name) && fs.existsSync(name)
          ? name
          : findOnPath([name], resolved);
        if (executable) {
          return {
            terminalId: DEFAULT_TERMINAL_ID,
            file: executable,
            args: [prefix, 'bash', '-lc', command]
          };
        }
      }
    }
    return null;
  },
  buildPlans: () => []
});
