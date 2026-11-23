import { memo } from 'react';
import { ReloadOutlined, SyncOutlined } from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import SettingStatusTag from '@/components/ui/SettingStatusTag';
import HudStateView from '@/components/hud/HudStateView';
import type { UsageRangeMode } from './model-usage-query';

export interface UsageEmptyStateProps {
  loading: boolean;
  error: string;
  hasActiveFilters: boolean;
  rangeMode: UsageRangeMode;
  canScan: boolean;
  scanning: boolean;
  onRetry: () => void;
  onExpandRange: () => void;
  onResetFilters: () => void;
  onScan: () => void;
}

/**
 * 统一的紧凑空/加载/错误态：避免两个空白图表并排占据整屏，
 * 直接说明原因并给出下一步明确操作。
 */
export const UsageEmptyState = memo(function UsageEmptyState({
  loading,
  error,
  hasActiveFilters,
  rangeMode,
  canScan,
  scanning,
  onRetry,
  onExpandRange,
  onResetFilters,
  onScan
}: UsageEmptyStateProps) {
  if (error) {
    return (
      <div className="usage-compact-state" role="alert">
        <SettingStatusTag status="error" label="加载失败" compact live="off" />
        <div className="usage-compact-state-copy">
          <strong>无法读取模型用量统计</strong>
          <p>{error}</p>
        </div>
        <div className="usage-compact-state-actions">
          <Button type="primary" icon={<ReloadOutlined />} onClick={onRetry}>
            重新加载
          </Button>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="usage-compact-state usage-compact-state--loading" role="status" aria-live="polite">
        <HudStateView
          compact
          variant="loading"
          code="SYNCING"
          title="正在汇总模型用量"
          description="首次统计或切换时间范围需要读取日志分片，请稍候。"
        />
      </div>
    );
  }

  const title = hasActiveFilters
    ? '当前筛选条件下没有用量记录'
    : '所选时间范围内暂无用量记录';
  const description = hasActiveFilters
    ? '可以清空 Provider / 模型筛选，或扩大时间范围查看历史调用。'
    : rangeMode === 'hour' || rangeMode === 'today'
      ? '最近尚未产生请求；可切换到「近 7 天」查看历史，或手动扫描本地用量日志。'
      : '发起请求后会自动记录用量；若已有本地 CLI 会话日志，可点击扫描同步。';

  return (
    <div className="usage-compact-state" role="status">
      <SettingStatusTag status="unset" label="无数据" compact live="off" />
      <div className="usage-compact-state-copy">
        <strong>{title}</strong>
        <p>{description}</p>
      </div>
      <div className="usage-compact-state-actions">
        {hasActiveFilters ? (
          <Button type="primary" onClick={onResetFilters}>
            重置筛选
          </Button>
        ) : null}
        {rangeMode !== '7d' && rangeMode !== 'month' ? (
          <Button type={hasActiveFilters ? 'default' : 'primary'} onClick={onExpandRange}>
            查看近 7 天
          </Button>
        ) : null}
        {canScan ? (
          <Button icon={<SyncOutlined />} loading={scanning} onClick={onScan}>
            扫描本地用量
          </Button>
        ) : null}
        <Button icon={<ReloadOutlined />} onClick={onRetry}>
          刷新
        </Button>
      </div>
    </div>
  );
});

export default UsageEmptyState;
