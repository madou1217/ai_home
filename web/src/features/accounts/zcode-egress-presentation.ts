import type {
  ProxyGroup,
  ProxyGroupStrategy,
  ProxyNode,
  ZcodeEgressApplyResult,
  ZcodeEgressRuntimeStatus
} from '@/types';

export const ZCODE_SIDECAR_PROTOCOLS = new Set([
  'shadowsocks',
  'vmess',
  'vless',
  'trojan',
  'hysteria2',
  'socks5',
  'http',
  'https'
]);

export const PROXY_GROUP_STRATEGY_OPTIONS: Array<{
  value: ProxyGroupStrategy;
  label: string;
}> = [
  { value: 'sticky', label: '固定节点，失效后再切换' },
  { value: 'lowest_latency', label: '优先最低延迟' },
  { value: 'round_robin', label: '顺序轮换' },
  { value: 'random', label: '随机选择' }
];

export function formatProxyNodeLabel(node: ProxyNode) {
  const location = [node.countryFlag, node.name].filter(Boolean).join(' ');
  return `${location || node.id} · ${node.protocol.toUpperCase()} · ${node.server}:${node.port}`;
}

export function formatProxyGroupLabel(group: ProxyGroup) {
  return `${group.icon || '◉'} ${group.name} · ${group.count} 个节点`;
}

export function describeProxyGroupKind(group?: ProxyGroup | null) {
  const labels: Record<string, string> = {
    manual: '手动组',
    subscription: '订阅自动组',
    country: '国家自动组',
    system: '系统自动组',
    tag: '标签自动组',
    custom: '自定义组'
  };
  return labels[String(group?.kind || '')] || '自动组';
}

export function describeApplyResult(apply: ZcodeEgressApplyResult | null) {
  if (!apply) return null;
  if (!apply.ok) {
    const detail = apply.reason || apply.error || 'unknown';
    if (apply.rolledBack) {
      return { color: 'warning', text: `切换失败，已恢复原节点：${detail}` };
    }
    return { color: 'error', text: `运行时应用失败：${detail}` };
  }
  if (!apply.applied || apply.status === 'pending_launch') {
    return { color: 'default', text: '绑定已保存；ZCode 尚未运行，将在下次启动时应用。' };
  }
  const action = apply.restarted
    ? '已接管并重启当前 ZCode 实例'
    : apply.rotated
      ? '已切换到新的分组节点'
      : apply.status === 'selected'
        ? '已热切换节点'
        : apply.status === 'restarted'
          ? 'sidecar 已重载'
          : '已实时应用';
  return { color: 'success', text: `${action}；ZCode 使用的账号固定本地端口保持不变。` };
}

export function describeRuntimeStatus(runtime?: ZcodeEgressRuntimeStatus | null) {
  if (!runtime?.running) return 'ZCode 账号出口尚未运行';
  if (!runtime.dataPlaneReady) return '账号出口进程存在，但数据面尚未就绪';
  if (runtime.selectedNodeId) return '账号出口正在通过分组节点运行';
  return '账号固定出口正在运行';
}
