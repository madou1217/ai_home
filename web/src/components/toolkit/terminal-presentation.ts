export interface TerminalLifecycleCapabilities {
  canUpdate: boolean;
  canUninstall: boolean;
}

export interface TerminalExecutableState {
  installed: boolean;
  default: boolean;
  executablePath: string;
}

export interface TerminalExecutablePresentation {
  value: string;
  tooltip: string;
  muted: boolean;
}

export function hasManagedTerminalLifecycle(terminal: TerminalLifecycleCapabilities) {
  return terminal.canUpdate && terminal.canUninstall;
}

export function getTerminalExecutablePresentation(
  terminal: TerminalExecutableState
): TerminalExecutablePresentation {
  if (!terminal.installed) {
    return { value: '未安装', tooltip: '当前主机尚未安装该终端', muted: true };
  }
  const executablePath = String(terminal.executablePath || '').trim();
  if (executablePath) {
    return { value: executablePath, tooltip: executablePath, muted: false };
  }
  if (terminal.default) {
    return {
      value: '由系统默认终端解析',
      tooltip: '启动时由当前操作系统解析默认终端',
      muted: true
    };
  }
  return { value: '未探测到', tooltip: '未探测到可执行路径', muted: true };
}
