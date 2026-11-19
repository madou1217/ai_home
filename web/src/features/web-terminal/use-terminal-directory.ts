import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { terminalAPI, type TerminalDirectorySession } from '@/services/api';
import {
  resolveActiveTransportTarget,
  subscribeTransportTargetChange,
} from '@/services/webui-auth-transport';

const EMPTY_SESSIONS: TerminalDirectorySession[] = [];
const DIRECTORY_POLL_INTERVAL_MS = 8000;
const DIRECTORY_FRESH_WINDOW_MS = 6000;
const DIRECTORY_ERROR_BASE_MS = 10_000;
const DIRECTORY_ERROR_MAX_MS = 30_000;
const DIRECTORY_MAX_CLOCK_SKEW_MS = 5000;
const DIRECTORY_CHANNEL_NAME = 'aih-terminal-directory-v1';

interface TerminalDirectoryBroadcast {
  type?: unknown;
  serverId?: unknown;
  scopeKey?: unknown;
  startedAt?: unknown;
  fetchedAt?: unknown;
  sessions?: unknown;
}

function getTransportScopeKeySnapshot(): string {
  return resolveActiveTransportTarget().scopeKey;
}

function getServerTransportScopeKeySnapshot(): string {
  return 'local';
}

function isValidDirectorySession(value: unknown): value is TerminalDirectorySession {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (typeof item.sessionKey !== 'string' || item.sessionKey.trim().length === 0) return false;
  if (typeof item.label !== 'string' || typeof item.cwd !== 'string') return false;
  if (item.source !== 'native' && item.source !== 'web') return false;
  if (item.status !== 'running' && item.status !== 'exited') return false;
  if (item.termId !== undefined && typeof item.termId !== 'string') return false;
  if (item.provider !== undefined && typeof item.provider !== 'string') return false;
  if (item.nativeSessionId !== undefined && typeof item.nativeSessionId !== 'string') return false;
  return true;
}

function readValidTimestamp(value: unknown, now: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  if (value > now + DIRECTORY_MAX_CLOCK_SKEW_MS) return null;
  return value;
}

export function useTerminalDirectory(serverId: string, enabled = true) {
  const transportScopeKey = useSyncExternalStore(
    subscribeTransportTargetChange,
    getTransportScopeKeySnapshot,
    getServerTransportScopeKeySnapshot,
  );
  // Returning to the same server, changing its target endpoint/scopeKey, or
  // re-enabling discovery starts a new observation lifecycle so stale requests
  // and old-endpoint BroadcastChannel snapshots are rejected immediately.
  const lifecycle = useMemo(
    () => ({ serverId, enabled, scopeKey: transportScopeKey }),
    [serverId, enabled, transportScopeKey],
  );
  const latest = useRef(lifecycle);
  latest.current = lifecycle;
  const active = useRef<typeof lifecycle | null>(null);
  const generation = useRef(0);
  const pending = useRef<number | null>(null);
  const failureCountRef = useRef(0);
  // Unified request-start watermark shared between local listSessions() and
  // BroadcastChannel snapshots so a slow older local R1 never overwrites or
  // rebroadcasts over a newer R2 accepted from another tab.
  const latestAcceptedStartAtRef = useRef(0);
  const latestAcceptedFromBcRef = useRef(false);
  const lastFreshReceivedAtRef = useRef(0);
  const lifecycleStartedAtRef = useRef(0);
  const channelRef = useRef<BroadcastChannel | null>(null);
  const scheduleNextRef = useRef<(delayMs?: number) => void>(() => {});
  const [state, setState] = useState<{
    lifecycle: typeof lifecycle;
    sessions: TerminalDirectorySession[];
    loading: boolean;
    error: string;
  }>({ lifecycle, sessions: EMPTY_SESSIONS, loading: enabled, error: '' });

  const nextPollDelayMs = useCallback(() => {
    const failures = failureCountRef.current;
    if (failures <= 0) return DIRECTORY_POLL_INTERVAL_MS;
    return Math.min(DIRECTORY_ERROR_MAX_MS, DIRECTORY_ERROR_BASE_MS * 2 ** Math.min(failures - 1, 2));
  }, []);

  const refresh = useCallback(async () => {
    if (!enabled || latest.current !== lifecycle || active.current !== lifecycle || pending.current !== null) return;
    const requestScopeKey = lifecycle.scopeKey;
    const isScopeLive = () => resolveActiveTransportTarget().scopeKey === requestScopeKey;
    if (!isScopeLive()) return;
    const request = ++generation.current;
    pending.current = request;
    const startedAt = Date.now();
    const isCurrent = () => latest.current === lifecycle && active.current === lifecycle
      && request === generation.current;
    const isSupersededByNewerSnapshot = () => (
      startedAt < latestAcceptedStartAtRef.current
      || (startedAt === latestAcceptedStartAtRef.current && latestAcceptedFromBcRef.current)
    );
    try {
      const result = await terminalAPI.listSessions();
      if (!isCurrent() || !isScopeLive() || isSupersededByNewerSnapshot()) return;
      if (!result.ok || !Array.isArray(result.sessions)) throw new Error('会话清单暂时不可用');
      const fetchedAt = Date.now();
      failureCountRef.current = 0;
      latestAcceptedStartAtRef.current = startedAt;
      latestAcceptedFromBcRef.current = false;
      lastFreshReceivedAtRef.current = fetchedAt;
      setState({ lifecycle, sessions: result.sessions, loading: false, error: '' });
      if (result.sessions.every(isValidDirectorySession)) {
        try {
          channelRef.current?.postMessage({
            type: 'sessions',
            serverId,
            scopeKey: requestScopeKey,
            startedAt,
            fetchedAt,
            sessions: result.sessions,
          });
        } catch (_error) {
          // Cross-tab sharing is best-effort; never fail local directory updates.
        }
      }
    } catch (error) {
      if (!isCurrent() || !isScopeLive() || isSupersededByNewerSnapshot()) return;
      failureCountRef.current += 1;
      setState((current) => ({
        lifecycle, sessions: current.lifecycle === lifecycle ? current.sessions : EMPTY_SESSIONS,
        loading: false, error: error instanceof Error ? error.message : '会话清单读取失败',
      }));
    } finally {
      if (pending.current === request) pending.current = null;
      if (isCurrent() && isScopeLive()) {
        const elapsedSinceFresh = lastFreshReceivedAtRef.current > 0
          ? Date.now() - lastFreshReceivedAtRef.current
          : DIRECTORY_POLL_INTERVAL_MS;
        const delayMs = isSupersededByNewerSnapshot()
          ? Math.max(500, DIRECTORY_POLL_INTERVAL_MS - elapsedSinceFresh)
          : nextPollDelayMs();
        scheduleNextRef.current(delayMs);
      }
    }
  }, [enabled, lifecycle, nextPollDelayMs, serverId]);

  useEffect(() => {
    active.current = lifecycle;
    failureCountRef.current = 0;
    latestAcceptedStartAtRef.current = 0;
    latestAcceptedFromBcRef.current = false;
    lastFreshReceivedAtRef.current = 0;
    lifecycleStartedAtRef.current = Date.now();
    const expectedScopeKey = lifecycle.scopeKey;
    const isScopeLive = () => resolveActiveTransportTarget().scopeKey === expectedScopeKey;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const clearTimer = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };
    const scheduleNext = (delayMs = DIRECTORY_POLL_INTERVAL_MS) => {
      clearTimer();
      if (active.current !== lifecycle || latest.current !== lifecycle || !enabled || !isScopeLive()) return;
      if (typeof document !== 'undefined' && document.hidden) return;
      timer = setTimeout(() => {
        timer = null;
        if (active.current !== lifecycle || latest.current !== lifecycle || !enabled || !isScopeLive()) return;
        if (typeof document !== 'undefined' && document.hidden) return;
        const elapsed = Date.now() - lastFreshReceivedAtRef.current;
        if (lastFreshReceivedAtRef.current > 0 && elapsed < DIRECTORY_FRESH_WINDOW_MS) {
          scheduleNext(Math.max(500, DIRECTORY_POLL_INTERVAL_MS - elapsed));
          return;
        }
        void refresh();
      }, delayMs);
    };
    scheduleNextRef.current = scheduleNext;

    const invalidate = () => {
      clearTimer();
      scheduleNextRef.current = () => {};
      if (channelRef.current) {
        try { channelRef.current.close(); } catch (_error) { /* ignore */ }
        channelRef.current = null;
      }
      if (active.current === lifecycle) {
        active.current = null;
        generation.current += 1;
        pending.current = null;
      }
    };
    if (!enabled) return invalidate;

    if (typeof BroadcastChannel !== 'undefined') {
      try {
        const channel = new BroadcastChannel(DIRECTORY_CHANNEL_NAME);
        channelRef.current = channel;
        channel.onmessage = (event: MessageEvent) => {
          if (active.current !== lifecycle || latest.current !== lifecycle || !isScopeLive()) return;
          const payload = (event.data || {}) as TerminalDirectoryBroadcast;
          if (
            payload.type !== 'sessions'
            || payload.serverId !== serverId
            || payload.scopeKey !== expectedScopeKey
            || !Array.isArray(payload.sessions)
          ) {
            return;
          }
          const now = Date.now();
          const startedAt = readValidTimestamp(payload.startedAt, now);
          const fetchedAt = readValidTimestamp(payload.fetchedAt, now);
          if (startedAt === null || fetchedAt === null || fetchedAt < startedAt) return;
          if (startedAt < lifecycleStartedAtRef.current) return;
          if (startedAt <= latestAcceptedStartAtRef.current) return;
          if (!payload.sessions.every(isValidDirectorySession)) return;
          failureCountRef.current = 0;
          latestAcceptedStartAtRef.current = startedAt;
          latestAcceptedFromBcRef.current = true;
          lastFreshReceivedAtRef.current = now;
          setState({
            lifecycle,
            sessions: payload.sessions,
            loading: false,
            error: '',
          });
          scheduleNext(DIRECTORY_POLL_INTERVAL_MS);
        };
      } catch (_error) {
        channelRef.current = null;
      }
    }

    void refresh();
    const resume = () => {
      if (document.hidden) {
        clearTimer();
        return;
      }
      if (!isScopeLive()) return;
      const elapsed = Date.now() - lastFreshReceivedAtRef.current;
      if (lastFreshReceivedAtRef.current > 0 && elapsed < DIRECTORY_FRESH_WINDOW_MS) {
        scheduleNext(Math.max(500, DIRECTORY_POLL_INTERVAL_MS - elapsed));
        return;
      }
      void refresh();
    };
    document.addEventListener('visibilitychange', resume);
    return () => {
      invalidate();
      document.removeEventListener('visibilitychange', resume);
    };
  }, [enabled, lifecycle, refresh, serverId]);

  const snapshot = enabled && state.lifecycle === lifecycle
    ? state : { sessions: EMPTY_SESSIONS, loading: enabled, error: '' };
  return { sessions: snapshot.sessions, loading: snapshot.loading, error: snapshot.error, enabled, lifecycle, refresh };
}
