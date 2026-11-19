/**
 * Local WebSocket transport adapter for `/v0/webui/terminal/mux` so active
 * Office / Global Web Terminal panels do not consume HTTP/1.1 connection slots.
 *
 * Credentials travel exclusively in the first WebSocket JSON text frame
 * (`{ authorization, muxId }`) and never in URL query parameters. Remote
 * control-plane targets stay on AuthorizedWebUiEventSource SSE.
 */
export const TERMINAL_MUX_WEBSOCKET_PATH = '/v0/webui/terminal/mux/ws';

const MAX_PAUSED_FRAMES = 512;
const MAX_UNOPENED_WS_PROBES = 2;
const WS_RECONNECT_BASE_MS = 1000;
const WS_RECONNECT_MAX_MS = 15_000;
const WS_AUTH_OR_POLICY_CLOSE_CODES = new Set([1008, 4400, 4401, 4403]);

export interface TerminalMuxTarget {
  readonly muxId: string;
}

export type TerminalMuxFallbackSource = EventSource & {
  setReadPaused?: (paused: boolean) => void;
};

export interface TerminalMuxWebSocketOptions {
  readonly origin: string;
  readonly muxId: string;
  readonly readManagementKey: () => string;
  readonly silenceTimeoutMs?: number;
  readonly createSseFallback?: () => TerminalMuxFallbackSource;
}

export function readTerminalMuxTarget(path: string): TerminalMuxTarget | null {
  try {
    const url = new URL(path, 'http://aih.invalid');
    if (url.pathname !== '/v0/webui/terminal/mux') return null;
    const muxId = String(url.searchParams.get('muxId') || '').trim();
    if (!muxId) return null;
    return { muxId };
  } catch (_error) {
    return null;
  }
}

function buildSameOriginWebSocketUrl(origin: string): string {
  const url = new URL(TERMINAL_MUX_WEBSOCKET_PATH, origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.search = '';
  url.hash = '';
  return url.toString();
}

export class TerminalMuxWebSocketSource extends EventTarget {
  readonly url: string;
  readonly withCredentials = false;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSED = 2;
  readyState = this.CONNECTING;
  onopen: ((this: EventSource, event: Event) => unknown) | null = null;
  onmessage: ((this: EventSource, event: MessageEvent) => unknown) | null = null;
  onerror: ((this: EventSource, event: Event) => unknown) | null = null;

  private socket: WebSocket | null = null;
  private socketGen = 0;
  private fallbackSource: TerminalMuxFallbackSource | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectAttempt = 0;
  private unopenedFailures = 0;
  private wsSupportedConfirmed = false;
  private readPaused = false;
  private pausedQueue: string[] = [];
  private drainingQueue = false;
  private lastActivityAt = Date.now();
  private closed = false;
  private readonly silenceTimeoutMs: number;

  private checkConnection = () => {
    if (
      this.closed
      || this.fallbackSource
      || this.readPaused
      || this.silenceTimeoutMs <= 0
      || !this.socket
    ) {
      return;
    }
    if (Date.now() - this.lastActivityAt >= this.silenceTimeoutMs) {
      this.failCurrentSocket(this.socket, this.socketGen);
    }
  };

  private handleOnline = () => {
    if (this.closed || this.fallbackSource) return;
    this.reconnectAttempt = 0;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      this.connect();
      return;
    }
    if (this.silenceTimeoutMs > 0 && !this.readPaused && this.socket) {
      this.failCurrentSocket(this.socket, this.socketGen);
    }
  };

  private handlePageHide = (event: PageTransitionEvent) => {
    if (!event.persisted) {
      this.close();
      return;
    }
    if (this.socket) {
      this.failCurrentSocket(this.socket, this.socketGen);
    }
  };

  constructor(private readonly options: TerminalMuxWebSocketOptions) {
    super();
    this.url = buildSameOriginWebSocketUrl(options.origin);
    this.silenceTimeoutMs = Math.max(0, Number(options.silenceTimeoutMs) || 0);
    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.handleOnline);
      window.addEventListener('pagehide', this.handlePageHide);
    }
    if (this.silenceTimeoutMs > 0 && typeof window !== 'undefined') {
      this.watchdogTimer = setInterval(this.checkConnection, Math.min(5000, this.silenceTimeoutMs));
      if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', this.checkConnection);
      }
    }
    queueMicrotask(() => this.connect());
  }

  setReadPaused(paused: boolean): void {
    this.readPaused = paused;
    if (this.fallbackSource) {
      this.fallbackSource.setReadPaused?.(paused);
      return;
    }
    if (this.closed) return;
    if (!paused) {
      this.lastActivityAt = Date.now();
    }
    this.sendControlFrame(paused ? 'pause' : 'resume');
    if (!paused) {
      this.drainPausedQueue(this.socketGen);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = this.CLOSED;
    this.socketGen += 1;
    this.pausedQueue.length = 0;
    this.clearTimersAndListeners();
    if (this.socket) {
      this.detachSocket(this.socket);
      this.socket = null;
    }
    if (this.fallbackSource) {
      const fallback = this.fallbackSource;
      this.fallbackSource = null;
      fallback.onopen = null;
      fallback.onmessage = null;
      fallback.onerror = null;
      try { fallback.close(); } catch (_error) { /* ignore */ }
    }
  }

  private clearTimersAndListeners(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.watchdogTimer !== null) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.checkConnection);
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.handleOnline);
      window.removeEventListener('pagehide', this.handlePageHide);
    }
  }

  private detachSocket(socket: WebSocket): void {
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    try { socket.close(); } catch (_error) { /* ignore */ }
  }

  private sendControlFrame(type: 'pause' | 'resume'): void {
    if (this.closed || !this.socket || this.readyState !== this.OPEN || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }
    try {
      this.socket.send(JSON.stringify({ type }));
    } catch (_error) {
      // Socket close/reconnect path handles broken transports.
    }
  }

  private emit(type: 'open' | 'error' | 'message', data?: string): void {
    if (this.closed) return;
    const event = type === 'message' ? new MessageEvent('message', { data }) : new Event(type);
    const source = this as unknown as EventSource;
    if (type === 'message') this.onmessage?.call(source, event as MessageEvent);
    else if (type === 'open') this.onopen?.call(source, event);
    else this.onerror?.call(source, event);
    this.dispatchEvent(event);
  }

  private drainPausedQueue(expectedGen: number): void {
    if (this.drainingQueue) return;
    this.drainingQueue = true;
    try {
      while (!this.closed && !this.readPaused && this.socketGen === expectedGen && this.pausedQueue.length > 0) {
        const nextFrame = this.pausedQueue.shift();
        if (nextFrame !== undefined) {
          this.emit('message', nextFrame);
        }
      }
    } finally {
      this.drainingQueue = false;
    }
  }

  private failCurrentSocket(socket: WebSocket, gen: number): void {
    if (this.closed || this.socket !== socket || this.socketGen !== gen) return;
    this.socketGen += 1;
    this.socket = null;
    this.pausedQueue.length = 0;
    this.detachSocket(socket);
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.closed || this.fallbackSource || this.reconnectTimer !== null) return;
    this.readyState = this.CONNECTING;
    this.emit('error');
    if (this.closed || this.fallbackSource) return;
    const baseDelayMs = Math.min(
      WS_RECONNECT_MAX_MS,
      WS_RECONNECT_BASE_MS * 2 ** Math.min(this.reconnectAttempt, 4),
    );
    const jitterMs = this.reconnectAttempt > 0 ? Math.floor(Math.random() * 250) : 0;
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, baseDelayMs + jitterMs);
  }

  private activateSseFallback(): void {
    if (this.closed || this.fallbackSource || !this.options.createSseFallback) return;
    this.socketGen += 1;
    this.pausedQueue.length = 0;
    this.clearTimersAndListeners();
    this.readyState = this.CONNECTING;
    const fallback = this.options.createSseFallback();
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
    if (this.readPaused) {
      fallback.setReadPaused?.(true);
    }
  }

  private connect(): void {
    if (this.closed || this.fallbackSource) return;
    const gen = ++this.socketGen;
    this.readyState = this.CONNECTING;
    this.pausedQueue.length = 0;
    this.lastActivityAt = Date.now();

    let socket: WebSocket;
    try {
      socket = new WebSocket(this.url);
    } catch (_error) {
      this.unopenedFailures += 1;
      if (
        !this.wsSupportedConfirmed
        && this.unopenedFailures >= MAX_UNOPENED_WS_PROBES
        && this.options.createSseFallback
      ) {
        this.activateSseFallback();
        return;
      }
      this.scheduleReconnect();
      return;
    }

    this.socket = socket;
    let opened = false;

    socket.onopen = () => {
      if (this.closed || this.socket !== socket || this.socketGen !== gen) return;
      opened = true;
      this.lastActivityAt = Date.now();
      const key = String(this.options.readManagementKey() || '').trim();
      try {
        socket.send(JSON.stringify({
          authorization: key ? `Bearer ${key}` : '',
          muxId: this.options.muxId,
        }));
      } catch (_error) {
        this.failCurrentSocket(socket, gen);
      }
    };

    socket.onmessage = (event) => {
      if (this.closed || this.socket !== socket || this.socketGen !== gen) return;
      if (typeof event.data !== 'string') {
        this.failCurrentSocket(socket, gen);
        return;
      }
      let payload: { type?: unknown } | null = null;
      try {
        payload = JSON.parse(event.data) as { type?: unknown };
      } catch (_error) {
        this.failCurrentSocket(socket, gen);
        return;
      }
      if (!payload || typeof payload !== 'object') {
        this.failCurrentSocket(socket, gen);
        return;
      }

      this.lastActivityAt = Date.now();
      if (payload.type === 'heartbeat') {
        return;
      }
      if (payload.type === 'connected') {
        this.wsSupportedConfirmed = true;
        this.unopenedFailures = 0;
        this.reconnectAttempt = 0;
        this.readyState = this.OPEN;
        this.emit('open');
        this.emit('message', event.data);
        if (this.readPaused && this.socket === socket && this.socketGen === gen) {
          this.sendControlFrame('pause');
        }
        return;
      }
      if (this.readyState !== this.OPEN) {
        this.failCurrentSocket(socket, gen);
        return;
      }
      if (this.readPaused || this.pausedQueue.length > 0) {
        if (this.pausedQueue.length >= MAX_PAUSED_FRAMES) {
          // Finite backpressure buffer overflow: disconnect cleanly so reconnect
          // triggers bounded server replay instead of silently dropping output.
          this.failCurrentSocket(socket, gen);
          return;
        }
        this.pausedQueue.push(event.data);
        if (!this.readPaused) {
          this.drainPausedQueue(gen);
        }
        return;
      }
      this.emit('message', event.data);
    };

    // Browser network errors are followed by onclose; centralize retry/fallback
    // transitions in onclose so a single failure never schedules two reconnects.
    socket.onerror = () => {
      // Handled by onclose.
    };

    socket.onclose = (event) => {
      if (this.closed || this.socket !== socket || this.socketGen !== gen) return;
      this.socket = null;
      this.pausedQueue.length = 0;
      const closeCode = typeof event?.code === 'number' ? event.code : 1006;
      const authOrPolicyFailure = WS_AUTH_OR_POLICY_CLOSE_CODES.has(closeCode);
      if (!opened && !authOrPolicyFailure && !this.wsSupportedConfirmed) {
        this.unopenedFailures += 1;
        if (
          this.unopenedFailures >= MAX_UNOPENED_WS_PROBES
          && this.options.createSseFallback
        ) {
          this.activateSseFallback();
          return;
        }
      } else if (opened) {
        this.unopenedFailures = 0;
      }
      this.scheduleReconnect();
    };
  }
}
