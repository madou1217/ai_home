import type { OutboundFailoverCheck, OutboundFailoverEvent } from '@/types';

const SKIP_REASONS: Record<string, string> = {
  disabled: '自动切换未开启',
  core_not_running: '内核未运行，未检测',
  direct_mode: '全局直连模式，无需出口',
  no_active_outbound: '尚未设置默认出口',
  outbound_changed_concurrently: '检测期间默认出口被手动修改，已放弃切换'
};

const SWITCH_REASONS: Record<string, string> = {
  unreachable: '连续不通',
  node_missing: '节点已被删除'
};

export type FailoverTone = 'success' | 'warning' | 'error' | 'default';

export function formatFailoverTime(at: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return `${seconds} 秒前`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} 分钟前`;
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 最近一次检测的一句话说明与色调。 */
export function describeFailoverCheck(check: OutboundFailoverCheck | null): { text: string; tone: FailoverTone } {
  if (!check) return { text: '尚未检测', tone: 'default' };
  switch (check.action) {
    case 'healthy':
      return { text: `默认出口可用（${check.latencyMs ?? '-'} ms）`, tone: 'success' };
    case 'degraded':
      return { text: `默认出口不通（连续 ${check.failures ?? 1} 次）`, tone: 'warning' };
    case 'switched':
      return check.event
        ? { text: `已切换：${check.event.from.name} → ${check.event.to.name}`, tone: 'success' }
        : { text: '已切换默认出口', tone: 'success' };
    case 'no_candidate':
      return { text: '默认出口不通，且没有其它可用节点，暂不切换', tone: 'error' };
    case 'failed':
      return { text: `检测失败：${check.reason || '未知原因'}`, tone: 'error' };
    default:
      return { text: SKIP_REASONS[check.reason || ''] || `已跳过：${check.reason || '未知原因'}`, tone: 'default' };
  }
}

export function describeFailoverEvent(event: OutboundFailoverEvent): string {
  const reason = SWITCH_REASONS[event.reason] || event.reason;
  return `${event.from.name} → ${event.to.name}（${event.to.latencyMs} ms，${reason}）`;
}
