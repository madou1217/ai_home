import { useCallback, useRef } from 'react';
import { message } from 'antd';
import { sshHostsAPI } from '@/services/api';
import { useWebTerminalManager } from './web-terminal-context';

/**
 * 打开远程工作区（SSH 开发机上的目录）的终端，统一放进全局 Web Terminal 浮窗。
 *
 * 远端 shell 跑在 Server 端的持久 PTY 里：刷新页面、断网重连都会 attach 回同一个会话，
 * 远端进程不受影响；远端机器不需要安装 aih 或任何 AI CLI。
 */
export function useOpenRemoteWorkspaceTerminal() {
  const manager = useWebTerminalManager();
  const pending = useRef(false);
  return useCallback(async (workspace: { id: string; label: string; remoteRoot: string }, options: { fresh?: boolean } = {}) => {
    if (pending.current) return false;
    pending.current = true;
    try {
      const result = await sshHostsAPI.openWorkspaceTerminal(workspace.id, { fresh: options.fresh });
      if (!result.ok || !result.sessionKey) {
        message.error('打开远程终端失败');
        return false;
      }
      manager.openTab({
        sessionKey: result.sessionKey,
        serverId: manager.serverId,
        label: `${workspace.label} · ${result.host || '远程'}`,
        cwd: workspace.remoteRoot,
        kind: 'shell',
      });
      if (manager.minimized) manager.setMinimized(false);
      if (result.reused) message.info('已回到正在运行的远程会话');
      return true;
    } catch (error: unknown) {
      const data = typeof error === 'object' && error
        ? (error as { response?: { data?: { message?: string; error?: string } } }).response?.data : undefined;
      message.error(`打开远程终端失败：${data?.message || data?.error || (error instanceof Error ? error.message : 'unknown')}`);
      return false;
    } finally {
      pending.current = false;
    }
  }, [manager]);
}
