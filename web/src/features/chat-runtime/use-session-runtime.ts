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
  | { readonly phase: 'ready'; readonly controller: SessionRuntimeController }
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
      (session) => onSessionResolvedRef.current?.(session),
    ).then(
      (opened) => {
        controller = opened;
        if (disposed) opened.dispose();
        else setConnection({ phase: 'ready', controller: opened });
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
  const session = target.nativeSessionId
    ? (await api.resolveSession({ ...target, nativeSessionId: target.nativeSessionId })).session
    : await api.createSession(target);
  const controller = new SessionRuntimeController(session.sessionId, api);
  try {
    await controller.start();
    onSessionResolved?.(session);
    return controller;
  } catch (error) {
    controller.dispose();
    throw error;
  }
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
  return { code: 'chat_runtime_failed', message: String(error) };
}
