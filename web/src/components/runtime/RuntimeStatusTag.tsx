import { Tag } from 'antd';

const RUNTIME_STATUS_META: Record<string, { color: string; label: string }> = {
  healthy: { color: 'success', label: '正常' },
  rate_limited: { color: 'orange', label: '限流中' },
  auth_invalid: { color: 'red', label: '认证失效' },
  overloaded: { color: 'gold', label: '上游繁忙' },
  transient_network: { color: 'purple', label: '网络抖动' },
  service_unavailable: { color: 'volcano', label: '服务不可用' },
  upstream_error: { color: 'magenta', label: '上游错误' },
  cooling_down: { color: 'default', label: '冷却中' },
  unknown: { color: 'default', label: '未知' }
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
}

const RuntimeStatusTag = ({ status, fallback }: RuntimeStatusTagProps) => {
  const meta = getRuntimeStatusMeta(status);
  return (
    <Tag color={meta.color}>
      {fallback || meta.label}
    </Tag>
  );
};

export default RuntimeStatusTag;
