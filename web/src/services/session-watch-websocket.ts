/** 后台原生会话的事件通道不占用 HTTP/1.1 的六个请求连接。 */
export const SESSION_WATCH_WEBSOCKET_PATH = '/v0/webui/sessions/watch/ws';

interface SessionWatchTarget {
  readonly provider: string;
  readonly sessionId: string;
  readonly projectDirName: string;
}

export function readSessionWatchTarget(path: string): SessionWatchTarget | null {
  const url = new URL(path, 'http://aih.invalid');
  if (url.pathname !== '/v0/webui/sessions/watch') return null;
  const provider = url.searchParams.get('provider') || '';
  const sessionId = url.searchParams.get('sessionId') || '';
  if (!provider || !sessionId) return null;
  return { provider, sessionId, projectDirName: url.searchParams.get('projectDirName') || '' };
}

export interface SessionWatchSocketOptions {
  readonly origin: string;
  readonly target: SessionWatchTarget;
  readonly readManagementKey: () => string;
}

export class SessionWatchWebSocketSource extends EventTarget {
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
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(private readonly options: SessionWatchSocketOptions) {
    super();
    const url = new URL(SESSION_WATCH_WEBSOCKET_PATH, options.origin);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    this.url = url.toString();
    queueMicrotask(() => this.connect());
  }

  close(): void {
    this.closed = true;
    this.readyState = this.CLOSED;
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.socket?.close();
    this.socket = null;
  }

  private emit(type: 'open' | 'error' | 'message', data?: string): void {
    const event = type === 'message' ? new MessageEvent('message', { data }) : new Event(type);
    const source = this as unknown as EventSource;
    if (type === 'message') this.onmessage?.call(source, event as MessageEvent);
    else if (type === 'open') this.onopen?.call(source, event);
    else this.onerror?.call(source, event);
    this.dispatchEvent(event);
  }

  private reconnect(): void {
    if (this.closed || this.reconnectTimer !== null) return;
    this.readyState = this.CONNECTING;
    this.emit('error');
    if (this.closed) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 1000);
  }

  private connect(): void {
    if (this.closed) return;
    let socket: WebSocket;
    try { socket = new WebSocket(this.url); } catch (_) { this.reconnect(); return; }
    this.socket = socket;
    socket.onopen = () => {
      if (this.closed || this.socket !== socket) return;
      socket.send(JSON.stringify({
        authorization: `Bearer ${this.options.readManagementKey()}`,
        ...this.options.target,
      }));
    };
    socket.onmessage = (event) => {
      if (this.closed || this.socket !== socket || typeof event.data !== 'string') return;
      let payload;
      try { payload = JSON.parse(event.data); } catch (_) { return; }
      if (payload?.type === 'connected') {
        this.readyState = this.OPEN;
        this.emit('open');
      }
      if (this.readyState === this.OPEN) this.emit('message', event.data);
    };
    // 浏览器 error 随后会触发 close；只在 close 中重连，避免双重订阅。
    socket.onerror = () => {
      // close 统一处理浏览器网络错误。
    };
    socket.onclose = () => {
      if (this.closed || this.socket !== socket) return;
      this.socket = null;
      this.reconnect();
    };
  }
}
