import { Tag, Tooltip } from 'antd';
import { formatAccountIssueReason } from '@/utils/account-reasons';
import { formatRuntimeReset } from './runtime-reset';

export { formatRuntimeReset, formatRuntimeUntil } from './runtime-reset';

// 颜色只表达语义（web/DESIGN.md §0.2）：antd 的状态预设 success / warning / error / default
// 由 AntdThemeProvider 的 token 驱动，深浅主题自动翻转；不再使用彩虹色预设。
const RUNTIME_STATUS_META: Record<string, { color: string; label: string }> = {
  healthy: { color: 'success', label: '正常' },
  billing_blocked: { color: 'error', label: '余额不足 / 账单受限' },
  quota_exhausted: { color: 'warning', label: '额度耗尽' },
  permission_denied: { color: 'error', label: '权限受限' },
  // 旧版账号级额度耗尽策略词；新数据已归一为 quota_exhausted。
  account_usage_exhausted: { color: 'warning', label: '额度耗尽' },
  account_no_resource_package: { color: 'warning', label: '额度耗尽' },
  rate_limited: { color: 'warning', label: '限流中' },
  auth_invalid: { color: 'error', label: '认证失效' },
  overloaded: { color: 'warning', label: '上游繁忙' },
  transient_network: { color: 'warning', label: '网络抖动' },
  service_unavailable: { color: 'error', label: '服务不可用' },
  upstream_error: { color: 'error', label: '上游错误' },
  cooling_down: { color: 'default', label: '冷却中' },
  unknown: { color: 'default', label: '未知' }
};

// 状态色 → HUD LED（只映射真实状态；default 为无辉光的中性灯）
const RUNTIME_STATUS_LED: Record<string, string> = {
  success: 'hud-led hud-led--ok',
  warning: 'hud-led hud-led--warn',
  error: 'hud-led hud-led--err'
};

export const getRuntimeStatusMeta = (status?: string) => {
  const key = String(status || 'unknown').trim() || 'unknown';
  return RUNTIME_STATUS_META[key] || {
    color: 'default',
    label: key
  };
};


interface RuntimeStatusTagProps {
  status?: string;
  fallback?: string;
  reason?: string;
  until?: number;
}

const RuntimeStatusTag = ({ status, fallback, reason, until }: RuntimeStatusTagProps) => {
  const meta = getRuntimeStatusMeta(status);
  const normalizedReason = String(reason || '').trim();
  const formattedReason = formatAccountIssueReason(normalizedReason);
  const resetLabel = formatRuntimeReset(status, until);
  const tag = (
    <Tag color={meta.color} className="runtime-status-tag">
      <span className={RUNTIME_STATUS_LED[meta.color] || 'hud-led'} aria-hidden="true" />
      {fallback || meta.label}
    </Tag>
  );
  if (!normalizedReason && !resetLabel) {
    return tag;
  }
  return (
    <Tooltip
      title={(
        <div className="runtime-status-tip">
          <div>{fallback || meta.label}</div>
          {normalizedReason ? <div>错误信息: {formattedReason}</div> : null}
          {resetLabel ? <div>恢复时间: {resetLabel}</div> : null}
        </div>
      )}
    >
      {tag}
    </Tooltip>
  );
};

export default RuntimeStatusTag;
