import type { MutableRefObject } from 'react';
import { useCallback, useEffect, useRef } from 'react';
import { guardedWebUiEventSource } from '@/services/api';
import {
  getGeneratingStatusText,
  getThinkingStatusText,
} from '@/components/chat/provider-pending-policy.js';
import type { RetryStatus } from '@/components/chat/provider-pending-policy.js';
import { supportsSessionWatchPending } from '@/components/chat/provider-capabilities.js';
import { resolveSessionWatchUpdateAction } from '@/components/chat/session-watch-state.js';
import type { Session } from '@/types';
import {
  isSameLegacySession,
  legacySessionEffectKey,
} from './legacy-session-history-state';

const WATCH_RECONNECT_DELAY_MS = 1200;

export type LegacySessionWatchPayload = Record<string, unknown>;

export interface LegacySessionWatchDisposition {
  readonly handled: boolean;
  readonly pendingStatus?: string;
  readonly pendingRetry?: RetryStatus;
  readonly failureText?: string;
}

interface SelectedSessionWatchOptions {
  readonly enabled: boolean;
  readonly selectedSession: Session | null;
  readonly selectedSessionRef: MutableRefObject<Session | null>;
  readonly onWatchEvent: (
    session: Session,
    payload: LegacySessionWatchPayload,
  ) => LegacySessionWatchDisposition;
  readonly onWatchSettled: (session: Session) => void;
  readonly clearWatchPending: () => void;
  readonly markWatchPending: (session: Session, statusText?: string) => void;
  readonly markWatchRetry: (session: Session, retryStatus: RetryStatus) => void;
  readonly markWatchFailed: (session: Session, failureText: string) => void;
  readonly scheduleSessionReload: (session: Session) => void;
  readonly cancelSessionReloads: (session: Session) => void;
}

export interface SelectedSessionWatch {
  readonly connect: (session: Session) => void;
  readonly clear: () => void;
}

interface ReconnectPolicyInput {
  readonly enabled: boolean;
  readonly online: boolean;
  readonly selectedSession: Session | null;
  readonly watchedSession: Session;
}

export function canReconnectSelectedSession({
  enabled,
  online,
  selectedSession,
  watchedSession,
}: ReconnectPolicyInput): boolean {
  return enabled
    && online
    && Boolean(selectedSession && !selectedSession.draft)
    && isSameLegacySession(selectedSession, watchedSession);
}

export function useSelectedSessionWatch({
  enabled,
  selectedSession,
  selectedSessionRef,
  onWatchEvent,
  onWatchSettled,
  clearWatchPending,
  markWatchPending,
  markWatchRetry,
  markWatchFailed,
  scheduleSessionReload,
  cancelSessionReloads,
}: SelectedSessionWatchOptions): SelectedSessionWatch {
  const sessionWatchRef = useRef<EventSource | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);

  const clear = useCallback((): void => {
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    sessionWatchRef.current?.close();
    sessionWatchRef.current = null;
  }, []);

  const connect = useCallback((session: Session): void => {
    if (!enabled || session.draft || !session.id || typeof window === 'undefined') return;
    clear();
    const params = new URLSearchParams({
      sessionId: session.id,
      provider: session.provider,
    });
    if (session.projectDirName) params.set('projectDirName', session.projectDirName);

    const eventSource = guardedWebUiEventSource(`/v0/webui/sessions/watch?${params.toString()}`);
    sessionWatchRef.current = eventSource;
    eventSource.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data) as LegacySessionWatchPayload;
        const disposition = onWatchEvent(session, payload);
        if (disposition.pendingStatus) markWatchPending(session, disposition.pendingStatus);
        if (disposition.pendingRetry) markWatchRetry(session, disposition.pendingRetry);
        if (disposition.failureText) markWatchFailed(session, disposition.failureText);
        if (disposition.handled) return;

        const action = resolveSessionWatchUpdateAction(payload);
        if (action.clearPending) {
          clearWatchPending();
          onWatchSettled(session);
        }
        if (action.markPending) {
          markWatchPending(
            session,
            supportsSessionWatchPending(session.provider)
              ? getThinkingStatusText(session.provider)
              : getGeneratingStatusText(),
          );
        }
        if (action.reload) scheduleSessionReload(session);
      } catch {}
    };

    eventSource.onerror = () => {
      eventSource.close();
      if (sessionWatchRef.current === eventSource) sessionWatchRef.current = null;
      if (reconnectTimerRef.current !== null) window.clearTimeout(reconnectTimerRef.current);
      if (!canReconnectSelectedSession({
        enabled,
        online: navigator.onLine,
        selectedSession: selectedSessionRef.current,
        watchedSession: session,
      })) return;
      reconnectTimerRef.current = window.setTimeout(() => {
        reconnectTimerRef.current = null;
        const latestSession = selectedSessionRef.current;
        if (!latestSession || latestSession.draft || !isSameLegacySession(latestSession, session)) return;
        connect(latestSession);
      }, WATCH_RECONNECT_DELAY_MS);
    };
  }, [
    clear,
    clearWatchPending,
    enabled,
    markWatchPending,
    markWatchRetry,
    markWatchFailed,
    onWatchEvent,
    onWatchSettled,
    scheduleSessionReload,
    selectedSessionRef,
  ]);

  const selectedSessionKey = legacySessionEffectKey(selectedSession);
  useEffect(() => {
    clear();
    const session = selectedSessionRef.current;
    if (!enabled
      || !session
      || session.draft
      || legacySessionEffectKey(session) !== selectedSessionKey) return;
    connect(session);
    return () => {
      clear();
      cancelSessionReloads(session);
    };
  }, [
    cancelSessionReloads,
    clear,
    connect,
    enabled,
    selectedSessionKey,
    selectedSessionRef,
  ]);

  useEffect(() => clear, [clear]);

  return { connect, clear };
}
