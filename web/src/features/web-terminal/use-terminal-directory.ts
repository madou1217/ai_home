import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { terminalAPI, type TerminalDirectorySession } from '@/services/api';
const EMPTY_SESSIONS: TerminalDirectorySession[] = [];

export function useTerminalDirectory(serverId: string, enabled = true) {
  // Returning to the same server (or re-enabling it) is a new observation, not
  // permission for an older in-flight request to publish its cached result.
  const lifecycle = useMemo(() => ({ serverId, enabled }), [serverId, enabled]);
  const latest = useRef(lifecycle);
  latest.current = lifecycle;
  const active = useRef<typeof lifecycle | null>(null);
  const generation = useRef(0);
  const pending = useRef<number | null>(null);
  const [state, setState] = useState<{
    lifecycle: typeof lifecycle;
    sessions: TerminalDirectorySession[];
    loading: boolean;
    error: string;
  }>({ lifecycle, sessions: EMPTY_SESSIONS, loading: enabled, error: '' });

  const refresh = useCallback(async () => {
    if (!enabled || latest.current !== lifecycle || active.current !== lifecycle || pending.current !== null) return;
    const request = ++generation.current;
    pending.current = request;
    const isCurrent = () => latest.current === lifecycle && active.current === lifecycle
      && request === generation.current;
    try {
      const result = await terminalAPI.listSessions();
      if (!isCurrent()) return;
      if (!result.ok || !Array.isArray(result.sessions)) throw new Error('会话清单暂时不可用');
      setState({ lifecycle, sessions: result.sessions, loading: false, error: '' });
    } catch (error) {
      if (!isCurrent()) return;
      setState((current) => ({
        lifecycle, sessions: current.lifecycle === lifecycle ? current.sessions : EMPTY_SESSIONS,
        loading: false, error: error instanceof Error ? error.message : '会话清单读取失败',
      }));
    } finally { if (pending.current === request) pending.current = null; }
  }, [enabled, lifecycle]);

  useEffect(() => {
    active.current = lifecycle;
    const invalidate = () => {
      if (active.current === lifecycle) {
        active.current = null;
        generation.current += 1;
        pending.current = null;
      }
    };
    if (!enabled) return invalidate;
    void refresh();
    const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 8000);
    const resume = () => { if (!document.hidden) void refresh(); };
    document.addEventListener('visibilitychange', resume);
    return () => {
      invalidate();
      clearInterval(timer);
      document.removeEventListener('visibilitychange', resume);
    };
  }, [enabled, lifecycle, refresh]);

  const snapshot = enabled && state.lifecycle === lifecycle
    ? state : { sessions: EMPTY_SESSIONS, loading: enabled, error: '' };
  return { sessions: snapshot.sessions, loading: snapshot.loading, error: snapshot.error, enabled, lifecycle, refresh };
}
