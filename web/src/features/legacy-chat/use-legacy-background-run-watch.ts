import type { MutableRefObject } from 'react';
import { useCallback, useEffect, useRef } from 'react';
import { guardedWebUiEventSource, sessionsAPI } from '@/services/api';
import { supportsBackgroundRunWatch } from '@/components/chat/provider-capabilities.js';
import type { Session } from '@/types';
import type { ActiveSessionRun } from './runtime-types';
import { legacySessionCacheKey } from './use-legacy-session-history';

type RunWatcher = {
  eventSource: EventSource | null;
  cursor: number;
  reconnectTimer: number | null;
};

interface LegacyBackgroundRunWatchOptions {
  readonly activeRunsRef: MutableRefObject<Map<string, ActiveSessionRun>>;
  readonly runningSessionKeys: Set<string>;
  readonly selectedSession: Session;
  readonly selectedSessionRef: MutableRefObject<Session | null>;
  readonly onToolCallBoundary: (session: Session) => void;
}

export function useLegacyBackgroundRunWatch({
  activeRunsRef,
  runningSessionKeys,
  selectedSession,
  selectedSessionRef,
  onToolCallBoundary,
}: LegacyBackgroundRunWatchOptions): void {
  const watchersRef = useRef<Map<string, RunWatcher>>(new Map());
  const clear = useCallback((runKey: string): void => {
    const watcher = watchersRef.current.get(runKey);
    if (!watcher) return;
    if (watcher.reconnectTimer !== null) window.clearTimeout(watcher.reconnectTimer);
    watcher.eventSource?.close();
    watchersRef.current.delete(runKey);
  }, []);
  const connect = useCallback((runKey: string, session: Session): void => {
    if (typeof window === 'undefined') return;
    if (!supportsBackgroundRunWatch(session.provider) || !session.id || session.draft) return;
    if (selectedSessionRef.current
      && legacySessionCacheKey(selectedSessionRef.current) === legacySessionCacheKey(session)) return;

    clear(runKey);
    const params = new URLSearchParams({ sessionId: session.id, provider: session.provider });
    if (session.projectDirName) params.set('projectDirName', session.projectDirName);
    const watcher: RunWatcher = {
      eventSource: guardedWebUiEventSource(`/v0/webui/sessions/watch?${params.toString()}`),
      cursor: 0,
      reconnectTimer: null,
    };
    watchersRef.current.set(runKey, watcher);
    watcher.eventSource!.onmessage = () => {
      sessionsAPI.getSessionEvents(
        session.provider,
        session.id,
        watcher.cursor,
        session.projectDirName,
      ).then((payload) => {
        watcher.cursor = payload.cursor;
        if (payload.hasAssistantToolCall
          || payload.events?.some((event) => event.type === 'assistant_tool_call')) {
          onToolCallBoundary(session);
        }
      }).catch(() => {});
    };
    watcher.eventSource!.onerror = () => {
      watcher.eventSource?.close();
      if (!activeRunsRef.current.has(runKey)) {
        clear(runKey);
        return;
      }
      if (watcher.reconnectTimer !== null) window.clearTimeout(watcher.reconnectTimer);
      watcher.reconnectTimer = window.setTimeout(() => connect(runKey, session), 1200);
    };
  }, [activeRunsRef, clear, onToolCallBoundary, selectedSessionRef]);

  useEffect(() => {
    watchersRef.current.forEach((_watcher, runKey) => {
      const run = activeRunsRef.current.get(runKey);
      if (!run?.sessionId) clear(runKey);
    });
    activeRunsRef.current.forEach((run, runKey) => {
      if (!run.sessionId) return;
      const session: Session = {
        id: run.sessionId,
        title: '',
        updatedAt: Date.now(),
        provider: run.provider,
        projectDirName: run.projectDirName,
        projectPath: run.projectPath,
      };
      if (legacySessionCacheKey(selectedSession) === legacySessionCacheKey(session)) {
        clear(runKey);
      } else if (!watchersRef.current.has(runKey)) {
        connect(runKey, session);
      }
    });
  }, [activeRunsRef, clear, connect, runningSessionKeys, selectedSession]);

  useEffect(() => () => {
    watchersRef.current.forEach((_watcher, runKey) => clear(runKey));
  }, [clear]);
}
