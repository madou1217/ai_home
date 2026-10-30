import { useCallback } from 'react';
import type { AccountAppLaunchResponse } from '@/types';
import { useWebTerminalManager } from './web-terminal-context';

/**
 * Server 把 CLI 启动改走 Web Terminal（`launchMode: 'webui-pty'`）时，把返回的 PTY 挂进
 * 全局浮窗。所有「打开 CLI」入口（账号页、Toolkit、任务队列）共用这一个适配，
 * 避免某个入口提示「已启动」却什么都看不到。返回 true 表示已在 Web Terminal 中打开。
 */
export function useAdoptLaunchedTerminal() {
  const manager = useWebTerminalManager();
  return useCallback((result: AccountAppLaunchResponse | undefined, fallbackLabel: string): boolean => {
    if (!result || result.launchMode !== 'webui-pty') return false;
    const sessionKey = String(result.sessionKey || '').trim();
    if (!sessionKey) return false;
    manager.openTab({
      sessionKey,
      serverId: manager.serverId,
      label: String(result.sessionTitle || fallbackLabel),
      kind: 'account-cli',
    });
    if (manager.minimized) manager.setMinimized(false);
    return true;
  }, [manager]);
}
