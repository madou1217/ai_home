import type {
  AccountEgressApplyResult,
  AccountEgressBinding,
  AccountEgressMode,
  AccountEgressRuntimeStatus
} from '@/types';

export const ACCOUNT_EGRESS_SOURCE_LABELS: Record<AccountEgressMode, string> = {
  url: '代理地址',
  system: '系统代理',
  tun: '外部 TUN',
  pool: 'AIH 出口池',
  direct: '直连'
};

const EGRESS_ERROR_LABELS: Record<string, string> = {
  invalid_proxy_url: '代理地址无效',
  proxy_scheme_unsupported: '只支持 HTTP(S) 与 SOCKS5 代理地址',
  zcode_native_proxy_scheme_unsupported: '该客户端只支持 HTTP(S) 代理（原生代理字段或运行时不认 SOCKS），SOCKS5 请改用 HTTP 端口',
  system_proxy_unavailable: '未检测到可用的系统代理',
  system_proxy_scheme_unavailable: '系统代理的协议类型不被该客户端支持（该客户端只认 HTTP(S) 代理，原生代理字段或运行时不认 SOCKS）',
  tun_inactive: '未检测到已激活的外部 TUN',
  tun_state_unknown: '无法确认外部 TUN 状态',
  account_egress_mode_retired: '节点 / 分组出口已下线，请改绑',
  proxy_unreachable: '代理出口连通性探测失败',
  not_supported: '当前平台不支持账号出口',
  unknown_egress_mode: '出口绑定模式无效',
  invalid_egress_mode: '出口模式无效',
  egress_apply_failed: '出口应用失败',
  egress_pool_not_ready: 'AIH 出口池尚未就绪（出口池只由运行中的 aih server 提供；server 未运行、池启动中或启动失败时不可用）',
  egress_pool_no_allowed_nodes: '所选节点都被该账号的上游拒绝，出口池没有可用节点',
  egress_region_denied_all_nodes: '所选节点都被该账号的上游按地区拒绝，请换节点范围或调整上游地区规则',
  egress_pool_geo_pending: '正在查询节点的真实位置，查到后自动放行允许的节点',
  egress_pool_scope_empty: '所选范围里没有节点（分组为空或节点已删除）',
  egress_pool_lane_overflow: '出口池车道已用满，请把部分账号改为「共享轮换」',
  egress_pool_lane_not_ready: '出口池正在为该账号选择节点，稍后重试',
  egress_pool_probe_unavailable: '出口池探测入口不可用（请重启 aih server 以加载新版出口池）',
  egress_region_denied: '当前网络被该账号的上游按地区拒绝，请设置出口',
  account_egress_region_denied: '当前网络被该账号的上游按地区拒绝，请设置出口',
  no_nodes_to_probe: '没有可测试的节点',
  upstream_not_found: '找不到该上游（账号可能已停用）'
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
  // direct 目标有两种来源：外部 TUN（tun）与显式直连（direct）。两者都不注入代理，
  // 但语义不同 —— TUN 是「交给外部 TUN」，直连是「明确不使用任何代理」。
  if (resolved.direct) {
    return resolved.source === 'direct'
      ? { state: 'ready' as const, text: '直连：该账号不使用任何代理' }
      : { state: 'ready' as const, text: '外部 TUN 已激活，账号流量由 TUN 接管' };
  }
  const label = ACCOUNT_EGRESS_SOURCE_LABELS[resolved.source as AccountEgressMode] || '外部代理';
  return { state: 'ready' as const, text: `经${label}出口` };
}
