/**
 * Per-subscription EventSource adapter for the multiplexed WebUI watch
 * WebSocket. Imports nothing from webui-auth-transport to keep module
 * dependencies strictly acyclic.
 */

export const WATCH_MULTIPLEX_WEBSOCKET_PATH = '/v0/webui/watch/ws';

export const WATCH_STABLE_RESET_MS = 10_000;
export const WATCH_BACKOFF_BASE_MS = 1000;
export const WATCH_BACKOFF_MAX_MS = 15_000;

const ALLOWED_WATCH_PATHS = new Set<string>([
  '/v0/webui/accounts/watch',
  '/v0/webui/tasks/watch',
  '/v0/webui/projects/watch',
  '/v0/webui/management/watch',
  '/v0/webui/peer/messages/watch',
  '/v0/webui/egress-upstreams/watch',
  '/v0/webui/ssh-connections/tunnels/watch',
  '/v0/webui/openai-models/watch',
  '/v0/webui/management/usage/dashboard/query/watch',
  '/v0/webui/management/usage/scan/watch',
  '/v0/webui/toolkit/subscription-aggregator/sources/sync/watch',
]);

export type WatchWebSocketSupportProbeResult = 'supported' | 'unsupported' | 'policy' | 'unknown';

export interface WatchMultiplexTargetScope {
  readonly scopeKey: string;
  readonly isRemote: boolean;
}

export interface WatchMultiplexOpenOptions {
  readonly origin: string;
  readonly path: string;
  readonly target: WatchMultiplexTargetScope;
  readonly readManagementKey: () => string;
  readonly isTargetStillValid: () => boolean;
  readonly subscribeTargetChange: (listener: () => void) => () => void;
  readonly createSseFallback: () => EventSource;
  readonly probeWebSocketSupport?: (signal: AbortSignal) => Promise<WatchWebSocketSupportProbeResult>;
}

export interface WatchMultiplexClientBridge {
  attach(source: WatchMultiplexEventSource): void;
  detach(source: WatchMultiplexEventSource): void;
  requestResubscribe(source: WatchMultiplexEventSource): void;
}

/**
 * Returns the exact canonical watch path if it belongs to the static 11-path
 * allowlist (rejecting any query string, fragment, traversal, or whitespace).
 */
export function readMultiplexedWatchPath(path: string): string | null {
  if (!path || /[?#\\\s]/.test(path) || path.includes('..')) {
    return null;
  }
  try {
    const parsed = new URL(path, 'http://aih.invalid');
    if (parsed.search !== '' || parsed.hash !== '' || parsed.pathname !== path) {
      return null;
    }
    return ALLOWED_WATCH_PATHS.has(parsed.pathname) ? parsed.pathname : null;
  } catch (_error) {
    return null;
  }
}

export function computeWatchBackoffMs(attempt: number): number {
  const baseDelayMs = Math.min(
    WATCH_BACKOFF_MAX_MS,
    WATCH_BACKOFF_BASE_MS * 2 ** Math.min(attempt, 4),
  );
  const jitterMs = attempt > 0 ? Math.floor(Math.random() * 250) : 0;
  return baseDelayMs + jitterMs;
}

export class WatchMultiplexEventSource extends EventTarget {
  readonly id: string;
  readonly path: string;
  readonly url: string;
  readonly withCredentials = false;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSED = 2;
  readyState = this.CONNECTING;
  onopen: ((this: EventSource, event: Event) => unknown) | null = null;
  onmessage: ((this: EventSource, event: MessageEvent) => unknown) | null = null;
  onerror: ((this: EventSource, event: Event) => unknown) | null = null;

  private readonly createSseFallback: () => EventSource;
  private client: WatchMultiplexClientBridge | null;
  private fallbackSource: EventSource | null = null;
  private closed = false;
  private attached = false;
  private retryAttempt = 0;
  private openedAt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private stableTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    id: string,
    path: string,
    createSseFallback: () => EventSource,
    client: WatchMultiplexClientBridge,
  ) {
    super();
    this.id = id;
    this.path = path;
    this.url = path;
    this.createSseFallback = createSseFallback;
    this.client = client;
    queueMicrotask(() => {
      if (this.closed || this.attached || !this.client) return;
      this.attached = true;
      this.client.attach(this);
    });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get isFallbackActive(): boolean {
    return this.fallbackSource !== null;
  }

  get isRetryPending(): boolean {
    return this.retryTimer !== null;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = this.CLOSED;
    this.clearTimers();
    this.closeFallbackSource();
    const client = this.client;
    this.client = null;
    if (this.attached && client) {
      this.attached = false;
      client.detach(this);
    }
  }

  /** Called by the owning client when the bound target scope is invalidated or unloaded. */
  forceCloseFromClient(): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = this.CLOSED;
    this.attached = false;
    this.client = null;
    this.clearTimers();
    this.closeFallbackSource();
  }

  handleOpen(): void {
    if (this.closed || this.fallbackSource) return;
    this.clearRetryTimer();
    this.openedAt = Date.now();
    this.armStableResetTimer();
    if (this.readyState !== this.OPEN) {
      this.readyState = this.OPEN;
      this.emit('open');
    }
  }

  handleMessage(data: string): void {
    if (this.closed || this.fallbackSource) return;
    if (this.readyState !== this.OPEN) {
      this.handleOpen();
    }
    if (this.closed || this.fallbackSource) return;
    this.emit('message', data);
  }

  handleSubError(code: string): void {
    if (this.closed || this.fallbackSource) return;
    this.settleStableWindow();
    this.readyState = this.CONNECTING;
    try {
      this.emit('error');
    } finally {
      // Explicit server policy/path rejection must never fall back to SSE or spin.
      if (!this.closed && !this.fallbackSource && code !== 'unsupported_watch_path') {
        this.scheduleResubscribe();
      }
    }
  }

  handleTransportDisconnect(emitError: boolean): void {
    if (this.closed || this.fallbackSource) return;
    this.settleStableWindow();
    this.clearRetryTimer();
    this.readyState = this.CONNECTING;
    if (emitError) {
      this.emit('error');
    }
  }

  activateFallback(): void {
    if (this.closed || this.fallbackSource) return;
    this.clearTimers();
    this.readyState = this.CONNECTING;
    const fallback = this.createSseFallback();
    this.fallbackSource = fallback;
    fallback.onopen = () => {
      if (this.closed || this.fallbackSource !== fallback) return;
      this.readyState = this.OPEN;
      this.emit('open');
    };
    fallback.onmessage = (event) => {
      if (this.closed || this.fallbackSource !== fallback) return;
      this.emit('message', String(event.data ?? ''));
    };
    fallback.onerror = () => {
      if (this.closed || this.fallbackSource !== fallback) return;
      this.readyState = this.CONNECTING;
      this.emit('error');
    };
  }

  private scheduleResubscribe(): void {
    if (this.closed || this.fallbackSource || this.retryTimer !== null || !this.client) return;
    const delayMs = computeWatchBackoffMs(this.retryAttempt);
    this.retryAttempt += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.closed || this.fallbackSource || !this.client) return;
      this.client.requestResubscribe(this);
    }, delayMs);
  }

  private armStableResetTimer(): void {
    this.clearStableTimer();
    this.stableTimer = setTimeout(() => {
      this.stableTimer = null;
      if (!this.closed && this.readyState === this.OPEN) {
        this.retryAttempt = 0;
      }
    }, WATCH_STABLE_RESET_MS);
  }

  private settleStableWindow(): void {
    this.clearStableTimer();
    if (this.openedAt > 0 && Date.now() - this.openedAt >= WATCH_STABLE_RESET_MS) {
      this.retryAttempt = 0;
    }
    this.openedAt = 0;
  }

  private clearRetryTimer(): void {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private clearStableTimer(): void {
    if (this.stableTimer !== null) {
      clearTimeout(this.stableTimer);
      this.stableTimer = null;
    }
  }

  private clearTimers(): void {
    this.clearRetryTimer();
    this.clearStableTimer();
  }

  private closeFallbackSource(): void {
    const fallback = this.fallbackSource;
    if (!fallback) return;
    this.fallbackSource = null;
    fallback.onopen = null;
    fallback.onmessage = null;
    fallback.onerror = null;
    try { fallback.close(); } catch (_error) { /* ignore */ }
  }

  private emit(type: 'open' | 'error' | 'message', data?: string): void {
    if (this.closed) return;
    const event = type === 'message' ? new MessageEvent('message', { data }) : new Event(type);
    const source = this as unknown as EventSource;
    try {
      if (type === 'message') this.onmessage?.call(source, event as MessageEvent);
      else if (type === 'open') this.onopen?.call(source, event);
      else this.onerror?.call(source, event);
    } catch (_error) {
      // Isolate consumer property-handler exceptions (EventSource semantics)
      // so EventTarget listeners, retries, and sibling subscriptions keep running.
    }
    if (this.closed) return;
    try {
      this.dispatchEvent(event);
    } catch (_error) {
      // Isolate EventTarget listener exceptions so delivery and reconnects continue.
    }
  }
}
