import type {
  AccountEgressApplyResult,
  AccountEgressBinding,
  AccountEgressMode,
  AccountEgressRuntimeStatus
} from '@/types';

export const ACCOUNT_EGRESS_SOURCE_LABELS: Record<AccountEgressMode, string> = {
  url: '代理地址',
  system: '系统代理',
  tun: '外部 TUN'
};

const EGRESS_ERROR_LABELS: Record<string, string> = {
  invalid_proxy_url: '代理地址无效',
  proxy_scheme_unsupported: '只支持 HTTP(S) 代理地址',
  system_proxy_unavailable: '未检测到可用的系统代理',
  system_proxy_http_unavailable: '系统代理只配置了 SOCKS，账号出口只支持 HTTP(S)',
  tun_inactive: '未检测到已激活的外部 TUN',
  tun_state_unknown: '无法确认外部 TUN 状态',
  account_egress_mode_retired: '节点 / 分组出口已下线，请改绑',
  proxy_unreachable: '代理出口连通性探测失败',
  not_supported: '当前平台不支持账号出口',
  unknown_egress_mode: '出口绑定模式无效',
  invalid_egress_mode: '出口模式无效',
  egress_apply_failed: '出口应用失败'
};

export function describeEgressError(code?: string | null) {
  const key = String(code || '').trim();
  return EGRESS_ERROR_LABELS[key] || key || '未知错误';
}

export function isRetiredEgressBinding(binding?: AccountEgressBinding | null) {
  return Boolean(binding?.retired);
}

export function describeApplyResult(apply: AccountEgressApplyResult | null) {
  if (!apply) return null;
  if (!apply.ok) {
    const detail = [describeEgressError(apply.error), apply.reason].filter(Boolean).join('：');
    return apply.rolledBack
      ? { color: 'warning', label: '已回退', text: `新出口不可用，已恢复原绑定（${detail}）` }
      : { color: 'error', label: '失败', text: `应用失败：${detail}` };
  }
  if (apply.status === 'restarted') {
    return { color: 'success', label: '已重启', text: '已用新出口重启运行中的桌面实例。' };
  }
  if (apply.status === 'cleared') {
    return { color: 'success', label: '已解除', text: '网关请求立即恢复默认网络；桌面端与 CLI 下次启动生效。' };
  }
  return { color: 'success', label: '已应用', text: '出口可用：网关请求立即生效；桌面端与 CLI 下次启动生效。' };
}

export function describeRuntimeStatus(runtime?: AccountEgressRuntimeStatus | null) {
  const resolved = runtime?.resolved;
  if (!resolved) return { state: 'idle' as const, text: '未绑定出口' };
  if (!resolved.ok) return { state: 'error' as const, text: `出口不可用：${describeEgressError(resolved.error)}` };
  if (resolved.direct) return { state: 'ready' as const, text: '外部 TUN 已激活，账号流量由 TUN 接管' };
  const label = ACCOUNT_EGRESS_SOURCE_LABELS[resolved.source as AccountEgressMode] || '外部代理';
  return { state: 'ready' as const, text: `经${label}出口` };
}
