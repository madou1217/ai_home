import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChatRuntimeApiError,
  SessionRuntimeController,
  createBrowserChatRuntimeApiClient,
} from '@/chat-runtime';
import type { ChatRuntimeApi, ChatRuntimeSession } from '@/chat-runtime';
import type {
  SessionRuntimeTarget,
  SessionRuntimeTargetResolution,
  RuntimeTargetBlockReason,
} from './session-surface-policy';

export interface RuntimeFailure {
  readonly code: string;
  readonly message: string;
}

export type SessionRuntimeConnection =
  | { readonly phase: 'pending' }
  | { readonly phase: 'blocked'; readonly reason: RuntimeTargetBlockReason }
  | { readonly phase: 'connecting' }
  | { readonly phase: 'ready'; readonly controller: SessionRuntimeController; readonly readOnly?: boolean }
  | { readonly phase: 'error'; readonly failure: RuntimeFailure };

const browserApi = createBrowserChatRuntimeApiClient();

export function useSessionRuntime(
  resolution: SessionRuntimeTargetResolution,
  runtimeInstanceKey: string,
  onSessionResolved?: (session: ChatRuntimeSession) => void,
): SessionRuntimeConnection & { readonly retry: () => void } {
  const [attempt, setAttempt] = useState(0);
  const resolutionKey = useMemo(
    () => targetKey(resolution, runtimeInstanceKey),
    [resolution, runtimeInstanceKey],
  );
  const resolutionRef = useRef(resolution);
  const onSessionResolvedRef = useRef(onSessionResolved);
  resolutionRef.current = resolution;
  onSessionResolvedRef.current = onSessionResolved;
  const [connection, setConnection] = useState<SessionRuntimeConnection>({ phase: 'pending' });
  const retry = useCallback(() => setAttempt((current) => current + 1), []);

  useEffect(() => {
    const activeResolution = resolutionRef.current;
    if (activeResolution.status === 'pending') {
      setConnection({ phase: 'pending' });
      return;
    }
    if (activeResolution.status === 'blocked') {
      setConnection({ phase: 'blocked', reason: activeResolution.reason });
      return;
    }

    let disposed = false;
    let controller: SessionRuntimeController | undefined;
    setConnection({ phase: 'connecting' });
    void openSessionRuntime(
      activeResolution.target,
      browserApi,
      (session) => {
        if (!disposed) onSessionResolvedRef.current?.(session);
      },
    ).then(
      (opened) => {
        controller = opened;
        if (disposed) opened.dispose();
        else setConnection({ phase: 'ready', controller: opened, readOnly: opened.readOnly });
      },
      (error: unknown) => {
        if (!disposed) setConnection({ phase: 'error', failure: runtimeFailure(error) });
      },
    );
    return () => {
      disposed = true;
      controller?.dispose();
    };
  }, [attempt, resolutionKey]);

  return { ...connection, retry };
}

export async function openSessionRuntime(
  target: SessionRuntimeTarget,
  api: ChatRuntimeApi,
  onSessionResolved?: (session: ChatRuntimeSession) => void,
): Promise<SessionRuntimeController> {
  let session: ChatRuntimeSession;
  let readOnly = Boolean(target.readOnly);
  try {
    session = target.nativeSessionId || target.sessionId
      ? (await api.resolveSession(target)).session
      : await api.createSession(target);
    // An already-running native turn belongs to the surface that started it.
    // Other surfaces still attach for live preview, but remain read-only until
    // the turn is over.
    if (!target.readOnly && (target.sessionId || target.chatSessionId || target.nativeSessionId)
      && isActiveSessionState(session.state)) {
      readOnly = true;
    }
  } catch (error) {
    // A running session may be observed by another WebUI surface. Retry as a
    // read-only attach so the timeline remains available while writes stay locked.
    if (readOnly || !(error instanceof ChatRuntimeApiError)
      || error.code !== 'chat_execution_credential_change_conflict') throw error;
    readOnly = true;
    const observerTarget = { ...target, readOnly: true };
    session = observerTarget.nativeSessionId || observerTarget.sessionId
      ? (await api.resolveSession(observerTarget)).session
      : await api.createSession(observerTarget);
  }
  const controller = new SessionRuntimeController(session.sessionId, api, {
    visibilitySource: typeof document === 'undefined' ? undefined : document,
  });
  Object.defineProperty(controller, 'readOnly', { value: readOnly, enumerable: false });
  try {
    await controller.start();
    onSessionResolved?.(session);
    return controller;
  } catch (error) {
    controller.dispose();
    throw error;
  }
}

function isActiveSessionState(state: ChatRuntimeSession['state']): boolean {
  return state === 'starting' || state === 'running' || state === 'waiting_input'
    || state === 'interrupting' || state === 'completing' || state === 'recovering';
}

function targetKey(
  resolution: SessionRuntimeTargetResolution,
  runtimeInstanceKey: string,
): string {
  if (resolution.status !== 'ready') return `${resolution.status}:${'reason' in resolution ? resolution.reason : ''}`;
  const target = resolution.target;
  return [
    target.provider, target.executionAccountRef, target.projectPath,
    runtimeInstanceKey,
  ].join('\u0000');
}

function runtimeFailure(error: unknown): RuntimeFailure {
  if (error instanceof ChatRuntimeApiError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof Error) return { code: error.name, message: error.message };
  return { code: 'chat_runtime_failed', message: formatUnknownFailure(error) };
}

function formatUnknownFailure(value: unknown): string {
  if (value === undefined || value === null) return 'Chat Runtime 连接失败';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of ['message', 'detail', 'error', 'reason']) {
      if (record[key] === undefined) continue;
      const nested = formatUnknownFailure(record[key]);
      if (nested) return nested;
    }
    try {
      const encoded = JSON.stringify(value);
      if (encoded && encoded !== '{}') return encoded;
    } catch (_error) {
      return Object.prototype.toString.call(value);
    }
  }
  return 'Chat Runtime 连接失败';
}
