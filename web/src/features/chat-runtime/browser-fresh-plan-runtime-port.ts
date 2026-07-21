import {
  SessionRuntimeController,
  createBrowserChatRuntimeApiClient,
} from '@/chat-runtime';
import type {
  ChatRuntimeApi,
  SessionProjection,
  SessionProjectionStore,
} from '@/chat-runtime';
import type {
  FreshPlanRuntimePort,
  FreshPlanRuntimeSession,
} from './fresh-plan-implementation-workflow';
import { FreshPlanRuntimeOpenError } from './fresh-plan-implementation-workflow';
import type { SessionRuntimeTarget } from './session-surface-policy';

const DEFAULT_NATIVE_BIND_TIMEOUT_MS = 15_000;
const DEFAULT_RUNTIME_CONNECTION_TIMEOUT_MS = 15_000;

interface BrowserFreshPlanRuntimePortOptions {
  readonly nativeBindTimeoutMs?: number;
  readonly connectionTimeoutMs?: number;
}

export class BrowserFreshPlanRuntimePort implements FreshPlanRuntimePort {
  private readonly nativeBindTimeoutMs: number;
  private readonly connectionTimeoutMs: number;

  constructor(
    private readonly api: ChatRuntimeApi = createBrowserChatRuntimeApiClient(),
    options: BrowserFreshPlanRuntimePortOptions = {},
  ) {
    this.nativeBindTimeoutMs = positiveTimeout(
      options.nativeBindTimeoutMs,
      DEFAULT_NATIVE_BIND_TIMEOUT_MS,
    );
    this.connectionTimeoutMs = positiveTimeout(
      options.connectionTimeoutMs,
      DEFAULT_RUNTIME_CONNECTION_TIMEOUT_MS,
    );
  }

  async open(target: SessionRuntimeTarget): Promise<FreshPlanRuntimeSession> {
    const session = await this.api.createSession(target);
    return this.connect(session.sessionId);
  }

  resume(canonicalSessionId: string): Promise<FreshPlanRuntimeSession> {
    return this.connect(canonicalSessionId);
  }

  private async connect(canonicalSessionId: string): Promise<FreshPlanRuntimeSession> {
    const controller = new SessionRuntimeController(canonicalSessionId, this.api);
    try {
      await controller.start();
      await waitForRuntimeConnection(controller.store, this.connectionTimeoutMs);
    } catch (error) {
      controller.dispose();
      throw new FreshPlanRuntimeOpenError(canonicalSessionId, error);
    }
    return {
      canonicalSessionId,
      submit: (commandId, content) => controller.dispatch({
        commandId,
        type: 'turn.submit',
        payload: { content },
      }),
      waitForNativeSessionId: () => waitForNativeSessionId(
        controller.store,
        this.nativeBindTimeoutMs,
      ),
      close: () => controller.dispose(),
    };
  }
}

export function waitForRuntimeConnection(
  store: SessionProjectionStore,
  timeoutMs = DEFAULT_RUNTIME_CONNECTION_TIMEOUT_MS,
): Promise<void> {
  const initial = runtimeConnectionResult(store.getSnapshot());
  if (initial === 'connected') return Promise.resolve();
  if (initial === 'failed') {
    return Promise.reject(new Error('chat_fresh_runtime_connection_failed'));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = globalThis.setTimeout(() => {
      settle(() => reject(new Error('chat_fresh_runtime_connection_timeout')));
    }, positiveTimeout(timeoutMs, DEFAULT_RUNTIME_CONNECTION_TIMEOUT_MS));
    const unsubscribe = store.subscribe(() => {
      const result = runtimeConnectionResult(store.getSnapshot());
      if (result === 'failed') {
        settle(() => reject(new Error('chat_fresh_runtime_connection_failed')));
      } else if (result === 'connected') {
        settle(resolve);
      }
    });

    function settle(effect: () => void): void {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timeout);
      unsubscribe();
      effect();
    }
  });
}

export function waitForNativeSessionId(
  store: SessionProjectionStore,
  timeoutMs = DEFAULT_NATIVE_BIND_TIMEOUT_MS,
): Promise<string> {
  const initial = store.getSnapshot();
  const existing = nativeSessionId(initial);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const timeout = globalThis.setTimeout(() => {
      unsubscribe();
      reject(new Error('chat_fresh_native_session_pending'));
    }, positiveTimeout(timeoutMs, DEFAULT_NATIVE_BIND_TIMEOUT_MS));
    const unsubscribe = store.subscribe(() => {
      const projection = store.getSnapshot();
      const nativeId = nativeSessionId(projection);
      if (nativeId) return settle(() => resolve(nativeId));
      if (projection.streamFailure) {
        return settle(() => reject(new Error('chat_fresh_native_session_pending')));
      }
    });

    function settle(effect: () => void): void {
      globalThis.clearTimeout(timeout);
      unsubscribe();
      effect();
    }
  });
}

function nativeSessionId(projection: SessionProjection): string {
  return String(projection.runtimeBinding?.nativeSessionId || '').trim();
}

function runtimeConnectionResult(
  projection: SessionProjection,
): 'connected' | 'failed' | 'pending' {
  if (projection.streamFailure) return 'failed';
  return projection.connectionState === 'connected' ? 'connected' : 'pending';
}

function positiveTimeout(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number(value) > 0 ? Number(value) : fallback;
}
