import { useCallback, useEffect, useRef, useState } from 'react';
import { terminalAPI, type TerminalDirectorySession } from '@/services/api';
const EMPTY_SESSIONS: TerminalDirectorySession[] = [];

export function useTerminalDirectory(serverId: string, enabled = true) {
  const [state, setState] = useState<{ serverId: string; sessions: TerminalDirectorySession[]; loading: boolean; error: string }>({ serverId, sessions: [], loading: true, error: '' });
  const scope = useRef(serverId);
  scope.current = serverId;
  const generation = useRef(0);
  const pending = useRef('');
  const refresh = useCallback(async () => {
    if (pending.current === serverId) return;
    const request = ++generation.current;
    pending.current = serverId;
    try {
      const result = await terminalAPI.listSessions();
      if (scope.current !== serverId || request !== generation.current) return;
      if (!result.ok || !Array.isArray(result.sessions)) throw new Error('会话清单暂时不可用');
      setState({ serverId, sessions: result.sessions, loading: false, error: '' });
    } catch (error) {
      if (scope.current !== serverId || request !== generation.current) return;
      setState((current) => ({ serverId, sessions: current.serverId === serverId ? current.sessions : [], loading: false, error: error instanceof Error ? error.message : '会话清单读取失败' }));
    } finally { if (request === generation.current) pending.current = ''; }
  }, [serverId]);
  useEffect(() => {
    if (!enabled) return;
    void refresh();
    const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 8000);
    const resume = () => { if (!document.hidden) void refresh(); };
    document.addEventListener('visibilitychange', resume);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', resume); };
  }, [enabled, refresh]);
  return { ...(state.serverId === serverId ? state : { sessions: EMPTY_SESSIONS, loading: true, error: '' }), refresh };
}
