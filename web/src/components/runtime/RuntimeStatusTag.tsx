import { Tag, Tooltip } from 'antd';
import { formatAccountIssueReason } from '@/utils/account-reasons';

// 颜色只表达语义（web/DESIGN.md §0.2）：antd 的状态预设 success / warning / error / default
// 由 AntdThemeProvider 的 token 驱动，深浅主题自动翻转；不再使用彩虹色预设。
const RUNTIME_STATUS_META: Record<string, { color: string; label: string }> = {
  healthy: { color: 'success', label: '正常' },
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

export const formatRuntimeUntil = (value?: number) => {
  const ts = Number(value || 0);
  if (!ts) return '-';
  if (ts <= Date.now()) return '已恢复';
  return new Date(ts).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
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
  const normalizedUntil = Number(until || 0);
  const tag = (
    <Tag color={meta.color} className="runtime-status-tag">
      <span className={RUNTIME_STATUS_LED[meta.color] || 'hud-led'} aria-hidden="true" />
      {fallback || meta.label}
    </Tag>
  );
  if (!normalizedReason && !normalizedUntil) {
    return tag;
  }
  return (
    <Tooltip
      title={(
        <div className="runtime-status-tip">
          <div>{fallback || meta.label}</div>
          {normalizedReason ? <div>错误信息: {formattedReason}</div> : null}
          {normalizedUntil ? <div>恢复时间: {formatRuntimeUntil(normalizedUntil)}</div> : null}
        </div>
      )}
    >
      {tag}
    </Tooltip>
  );
};

export default RuntimeStatusTag;
