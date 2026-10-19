// 出口池面板的纯展示逻辑（无 React / 无 @ 别名依赖，可直接用 node --experimental-strip-types 测试）。

export type NodeHealthTone = 'success' | 'warning' | 'danger' | 'neutral' | 'info';

export interface NodeHealthLike {
  name: string;
  uses: number;
  successes: number;
  failures: number;
  cooling: boolean;
  cooldownKind: string;
  cooldownRemainingMs: number;
  lastFailureKind: string;
  probe: { ok: boolean; latencyMs: number } | null;
}

const FAILURE_KIND_LABELS: Record<string, string> = {
  free_limit: '免费额度受限',
  gate: '免费档门禁',
  network: '节点不可达',
  ip_blocked: '出口 IP 被拉黑'
};

const EVENT_REASON_LABELS: Record<string, string> = {
  free_limit: '额度受限',
  gate: '门禁拒绝',
  network: '不可达',
  ip_blocked: 'IP 被拉黑',
  rotate: '轮换',
  select: '手动切换',
  manual: '手动解除',
  probe_ok: '探测恢复',
  request_succeeded: '请求成功',
  probe_unreachable: '探测失败'
};

export function failureKindLabel(kind: string): string {
  return FAILURE_KIND_LABELS[kind] || kind || '—';
}

export function eventReasonLabel(reason: string | undefined): string {
  if (!reason) return '';
  return EVENT_REASON_LABELS[reason] || reason;
}

/** 毫秒 → 「2 分 05 秒」/「45 秒」/「1 小时 3 分」。 */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(Number(ms) / 1000));
  if (total < 60) return `${total} 秒`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return `${minutes} 分 ${String(seconds).padStart(2, '0')} 秒`;
  const hours = Math.floor(minutes / 60);
  return `${hours} 小时 ${minutes % 60} 分`;
}

/** 相对时间：「刚刚」/「3 分钟前」/「2 小时前」/「5 天前」；0 = 从未。 */
export function formatAgo(at: number, now: number): string {
  if (!at) return '从未';
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 10) return '刚刚';
  if (seconds < 60) return `${seconds} 秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

/** 成功率（无请求时返回 null，界面显示「—」而不是 0%）。 */
export function successRate(node: Pick<NodeHealthLike, 'uses' | 'successes'>): number | null {
  if (!node.uses) return null;
  return Math.round((node.successes / node.uses) * 100);
}

/** 节点健康状态：冷却 > 探测失败 > 正常 > 未知。 */
export function nodeHealth(node: NodeHealthLike, activeNode: string): { tone: NodeHealthTone; label: string } {
  if (node.cooling) return { tone: 'warning', label: `冷却 · ${eventReasonLabel(node.cooldownKind) || failureKindLabel(node.cooldownKind)}` };
  if (node.probe && !node.probe.ok) return { tone: 'danger', label: '探测失败' };
  if (node.name === activeNode) return { tone: 'info', label: '当前出口' };
  if (node.probe && node.probe.ok) return { tone: 'success', label: '可用' };
  if (node.uses > 0 && node.failures === 0) return { tone: 'success', label: '可用' };
  return { tone: 'neutral', label: '未探测' };
}

export type NodeFilter = 'all' | 'healthy' | 'cooling' | 'used';

export function filterNodes<T extends NodeHealthLike>(nodes: T[], filter: NodeFilter, query: string): T[] {
  const needle = query.trim().toLowerCase();
  return nodes.filter((node) => {
    if (filter === 'cooling' && !node.cooling) return false;
    if (filter === 'healthy' && (node.cooling || (node.probe && !node.probe.ok))) return false;
    if (filter === 'used' && !node.uses) return false;
    if (!needle) return true;
    const haystack = `${node.name} ${(node as unknown as { label?: string }).label || ''} ${(node as unknown as { server?: string }).server || ''}`.toLowerCase();
    return haystack.includes(needle);
  });
}

/** 排序：当前出口置顶，其次冷却中（剩余时间短的先），再按最近使用。 */
export function sortNodes<T extends NodeHealthLike & { lastUsedAt?: number }>(nodes: T[], activeNode: string): T[] {
  return nodes.slice().sort((a, b) => {
    if (a.name === activeNode) return -1;
    if (b.name === activeNode) return 1;
    if (a.cooling !== b.cooling) return a.cooling ? -1 : 1;
    if (a.cooling && b.cooling) return a.cooldownRemainingMs - b.cooldownRemainingMs;
    return (b.lastUsedAt || 0) - (a.lastUsedAt || 0);
  });
}

/** 冷却策略说明（与后端常量同值；用于面板的「冷却规则」一行说明）。 */
export const COOLDOWN_RULES: Array<{ kind: string; label: string; detail: string }> = [
  { kind: 'free_limit', label: '免费额度受限（429）', detail: '跳过 15 分钟，连续受限翻倍，最长 30 分钟' },
  { kind: 'gate', label: '免费档门禁（403）', detail: '跳过 2 分钟，门禁随出口 IP 几分钟内翻转' },
  { kind: 'network', label: '节点不可达', detail: '跳过 1 分钟起；每分钟自动探测，探测通过立即恢复' },
  { kind: 'ip_blocked', label: '出口 IP 被拉黑（403 abusive traffic）', detail: '跳过 6 小时；可在节点上手动解除' }
];
