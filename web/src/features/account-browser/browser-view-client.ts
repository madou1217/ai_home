import { resolveWebUiManagementKey, resolveActiveServer } from '@/services/webui-auth-transport';

export interface BrowserSurfaceEvent {
  type: string;
  frame?: number;
  data?: string;
  error?: string;
  width?: number;
  height?: number;
}

export function connectBrowserSurface(onEvent: (event: BrowserSurfaceEvent) => void, onClose: () => void) {
  const target = resolveActiveServer();
  if (target.isRemote) throw new Error('此版本仅支持当前本机 Mac 的浏览器窗口，请先选择本机 Server');
  const url = new URL('/v0/webui/account-browser/live', window.location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(url);
  socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'auth', token: resolveWebUiManagementKey() })));
  socket.addEventListener('message', ({ data }) => {
    if (typeof data !== 'string' || data.length > 2 * 1024 * 1024) return;
    try { onEvent(JSON.parse(data)); } catch (_) { /* Discard malformed transport data. */ }
  });
  socket.addEventListener('close', onClose);
  socket.addEventListener('error', () => onEvent({ type: 'error', error: '浏览器连接失败' }));
  return {
    send(command: Record<string, unknown>) {
      if (socket.readyState !== WebSocket.OPEN) return false;
      if (socket.bufferedAmount > 128 * 1024) return false;
      socket.send(JSON.stringify(command));
      return true;
    },
    close() { socket.close(); }
  };
}
