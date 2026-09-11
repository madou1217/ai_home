import type { SessionConnectionState, SessionState } from '@/chat-runtime';

export function workspaceStatusLabel(
  state: SessionState,
  connectionState: SessionConnectionState,
  startedAt: number | undefined,
  now: number,
): string {
  if (connectionState !== 'connected') return CONNECTION_LABELS[connectionState];
  const label = STATE_LABELS[state];
  if (!ACTIVE_STATES.has(state) || startedAt === undefined) return label;
  return `${label} · ${Math.max(0, Math.floor((now - startedAt) / 1000))}秒`;
}

const ACTIVE_STATES = new Set<SessionState>([
  'starting', 'running', 'waiting_input', 'interrupting', 'completing', 'recovering',
]);

const STATE_LABELS: Readonly<Record<SessionState, string>> = {
  idle: '就绪', starting: '正在启动', running: '运行中', waiting_input: '等待输入',
  interrupting: '正在停止', completing: '正在收尾', recovering: '正在恢复', closed: '已关闭',
};

const CONNECTION_LABELS: Readonly<Record<SessionConnectionState, string>> = {
  connecting: '正在连接', connected: '已连接', reconnecting: '正在重连', resyncing: '正在同步',
};
