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
import { sessionOpenCoordinator } from './session-open-coordinator';

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
  const autoRetriesRef = useRef(0);
  // 本轮目标已经创建过的服务端会话：自动重试必须复用它，不能每重试一次就 POST
  // 创建一个新的空会话（外网代理抖动时会连出好几条，且这些空会话谁都不会再引用）。
  const createdSessionRef = useRef<{ key: string; session: ChatRuntimeSession } | null>(null);

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
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleTransientRetry = (error: unknown) => {
      if (autoRetriesRef.current >= 4 || !isTransientRuntimeFailure(error)) return;
      const delays = [1000, 2000, 5000, 10000];
      const delay = delays[Math.min(autoRetriesRef.current, delays.length - 1)];
      autoRetriesRef.current += 1;
      retryTimer = setTimeout(() => {
        if (!disposed) setAttempt((current) => current + 1);
      }, delay);
    };
    setConnection({ phase: 'connecting' });
    // 创建成功后立刻记住会话对象：同一目标的重试直接复用它，一次 HTTP 都不再发。
    // 没有 chatSessionId 的创建不是幂等操作，重试再建只会得到更多谁也不引用的空会话。
    const cached = createdSessionRef.current;
    void openSessionRuntime(activeResolution.target, browserApi, {
      existingSession: cached && cached.key === resolutionKey ? cached.session : undefined,
      onSessionAcquired: (session) => {
        createdSessionRef.current = { key: resolutionKey, session };
      },
      onSessionResolved: (session) => {
        if (!disposed) onSessionResolvedRef.current?.(session);
      },
      onStartError: (error) => {
        // 工作区已经先渲染；首屏快照失败时再用错误态替换，避免整屏空等。
        if (!disposed) {
          setConnection({ phase: 'error', failure: runtimeFailure(error) });
          scheduleTransientRetry(error);
        }
      },
    }).then(
      (opened) => {
        controller = opened;
        if (disposed) opened.dispose();
        else setConnection({ phase: 'ready', controller: opened, readOnly: opened.readOnly });
      },
      (error: unknown) => {
        if (!disposed) {
          setConnection({ phase: 'error', failure: runtimeFailure(error) });
          scheduleTransientRetry(error);
        }
      },
    );
    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      controller?.dispose();
    };
  }, [attempt, resolutionKey]);

  return { ...connection, retry };
}

export interface OpenSessionRuntimeOptions {
  readonly onSessionResolved?: (session: ChatRuntimeSession) => void;
  readonly onStartError?: (error: unknown) => void;
  /** 会话刚创建（或解析）出来就回调，供调用方在失败重试时复用。 */
  readonly onSessionAcquired?: (session: ChatRuntimeSession) => void;
  /** 已经创建过的会话：重试时直接复用，不再请求服务器。 */
  readonly existingSession?: ChatRuntimeSession;
}

export async function openSessionRuntime(
  target: SessionRuntimeTarget,
  api: ChatRuntimeApi,
  options: OpenSessionRuntimeOptions = {},
): Promise<SessionRuntimeController> {
  let session = options.existingSession;
  let readOnly = Boolean(target.readOnly);
  if (!session) {
    try {
      session = await sessionOpenCoordinator.open(target, api);
      options.onSessionAcquired?.(session);
    } catch (error) {
      // A running session may be observed by another WebUI surface. Retry as a
      // read-only attach so the timeline remains available while writes stay locked.
      if (readOnly || !(error instanceof ChatRuntimeApiError)
        || error.code !== 'chat_execution_credential_change_conflict') throw error;
      readOnly = true;
      const observerTarget = { ...target, readOnly: true };
      session = await sessionOpenCoordinator.open(observerTarget, api);
      options.onSessionAcquired?.(session);
    }
  }
  // An already-running native turn belongs to the surface that started it.
  // Other surfaces still attach for live preview, but remain read-only until
  // the turn is over.
  if (!target.readOnly && (target.sessionId || target.chatSessionId || target.nativeSessionId)
    && isActiveSessionState(session.state)) {
    readOnly = true;
  }
  const controller = new SessionRuntimeController(session.sessionId, api, {
    visibilitySource: typeof document === 'undefined' ? undefined : document,
  });
  Object.defineProperty(controller, 'readOnly', { value: readOnly, enumerable: false });
  // 先把控制器交给工作区，快照在后台加载：慢快照只让时间线晚到，不会让整页停在
  // 「正在连接原生运行时…」；首屏失败再通过 onStartError 切错误态。
  void controller.start().then(
    () => options.onSessionResolved?.(session),
    (error: unknown) => {
      controller.dispose();
      options.onStartError?.(error);
    },
  );
  return controller;
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

function isTransientRuntimeFailure(error: unknown): boolean {
  const code = error instanceof ChatRuntimeApiError
    ? String(error.code || '').toLowerCase()
    : String((error as { code?: string })?.code || '').toLowerCase();
  const message = String((error as Error)?.message || '').toLowerCase();
  if (/credential|auth|account|unsupported|policy|blocked|not_found|permission/.test(code)) return false;
  return /timeout|network|unavailable|closed|connect|socket|econn|502|503/.test(code)
    || /timeout|network|unavailable|connection|socket|econn/.test(message);
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
