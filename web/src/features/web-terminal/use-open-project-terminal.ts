import { useCallback, useRef } from 'react';
import { message } from 'antd';
import { terminalAPI } from '@/services/api';
import { useWebTerminalManager } from './web-terminal-context';

/**
 * 项目终端唯一入口：在全局 Web Terminal 浮窗里打开（或切回）某个目录的 shell。
 *
 * Chat / Work 不再各自内嵌终端面板；所有终端都走同一个浮窗（可拖动、四边缩放、最小化为
 * 停靠气泡、刷新不丢）。同一 Server + 同一目录复用同一个持久 PTY（sessionKey 稳定），
 * 重复点击只是把对应页签切到前台。
 */
export function projectTerminalSessionKey(serverId: string, cwd: string): string {
  return `project-shell:${encodeURIComponent(serverId || 'local')}:${encodeURIComponent(cwd || '~')}`;
}

function projectLabel(cwd: string): string {
  const parts = String(cwd || '').split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : 'Shell';
}

export function useOpenProjectTerminal() {
  const manager = useWebTerminalManager();
  const pending = useRef(false);
  return useCallback(async (cwd?: string) => {
    if (pending.current) return;
    const dir = String(cwd || '').trim();
    const sessionKey = projectTerminalSessionKey(manager.serverId, dir);
    const tabId = `web-terminal:${sessionKey}`;
    if (manager.tabs.some((tab) => tab.id === tabId)) {
      manager.setActiveTab(tabId);
      if (manager.minimized) manager.setMinimized(false);
      return;
    }
    pending.current = true;
    try {
      // 先在 Server 侧建好持久 PTY，再挂页签：浮窗挂载时直接 attach，避免空窗。
      const result = await terminalAPI.open(80, 24, undefined, dir || undefined, sessionKey);
      if (!result.ok || !result.termId) {
        message.error(`打开终端失败: ${result.error || 'unknown'}`);
        return;
      }
      manager.openTab({ sessionKey, serverId: manager.serverId, label: projectLabel(dir), cwd: dir, kind: 'shell' });
      if (manager.minimized) manager.setMinimized(false);
    } catch (error) {
      message.error(`打开终端失败: ${error instanceof Error ? error.message : 'unknown'}`);
    } finally {
      pending.current = false;
    }
  }, [manager]);
}
