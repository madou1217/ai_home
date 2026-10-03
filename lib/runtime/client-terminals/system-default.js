'use strict';

const { CLIENT_PLATFORMS } = require('../client-platform');
const {
  DEFAULT_TERMINAL_ID,
  escapeAppleScriptString,
  findOnPath,
  resolveContext
} = require('../client-terminal-support');
const { buildWindowsCmdLaunch } = require('../windows-cmd-launch');
const windowsTerminal = require('./windows-terminal');

function buildLaunch(command, title, context = {}) {
  const resolved = resolveContext(context);
  const { env, fs, path, platform } = resolved;
  if (platform === CLIENT_PLATFORMS.WINDOWS) {
    // Win10/11 的「默认终端应用」deflection 从隐藏/无控制台的父进程启动时不生效
    // （实测 detached+windowsHide 启动链里 start 只能拿到 conhost 窗口），因此
    // system-default 在探测到 wt.exe 时直接委托 Windows Terminal 插件；
    // 未安装 WT 的机器保持 cmd start 兜底。命令整链由内层 cmd /k 承载。
    const wtLaunch = windowsTerminal.buildLaunch(command, title, context);
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
}

// Windows 没有「系统默认终端」条目（由 Windows Terminal / CMD 承担），列表中隐藏它，
// 但启动链路仍接受 system-default 请求。
const systemDefault = {
  id: DEFAULT_TERMINAL_ID,
  capability: 'toolkit.terminal',
  name: '系统默认终端',
  description: '使用当前操作系统配置的默认终端。',
  sourceUrl: '',
  default: true,
  platforms: [CLIENT_PLATFORMS.MACOS, CLIENT_PLATFORMS.WINDOWS, CLIENT_PLATFORMS.LINUX],
  hiddenOnPlatforms: [CLIENT_PLATFORMS.WINDOWS],
  detect: () => ({ installed: true, executablePath: '' }),
  buildLaunch
};

module.exports = systemDefault;
