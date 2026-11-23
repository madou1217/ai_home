import { memo, type CSSProperties, type ReactNode } from 'react';
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  EditOutlined,
  LoadingOutlined,
  MinusCircleOutlined
} from '@ant-design/icons';
import './SettingStatusTag.css';

export type SettingStatusState =
  | 'dirty'
  | 'saved'
  | 'applied'
  | 'saving'
  | 'error'
  | 'unset'
  | 'pending_restart';

export interface SettingStatusTagProps {
  /** 语义状态：未保存 / 已保存 / 已应用 / 保存中 / 保存失败 / 未设定 / 待重启生效 */
  status: SettingStatusState;
  /** 可选自定义文案；默认按状态映射清晰中文标签，永不依赖纯颜色表达 */
  label?: ReactNode;
  /** 可选额外说明（用于无障碍 aria-label 或 tooltip title） */
  detail?: string;
  /** 紧凑尺寸，用于工具栏或行内槽位 */
  compact?: boolean;
  /** 仅在错误/保存中/更新完成后播报给读屏器；默认按状态自动推断 */
  live?: 'off' | 'polite' | 'assertive';
  className?: string;
  style?: CSSProperties;
}

const DEFAULT_LABELS: Record<SettingStatusState, string> = {
  dirty: '未保存',
  saved: '已保存',
  applied: '已应用',
  saving: '保存中',
  error: '保存失败',
  unset: '未设定',
  pending_restart: '已保存·待重启'
};

const STATE_ICONS: Record<SettingStatusState, ReactNode> = {
  dirty: <EditOutlined />,
  saved: <CheckCircleOutlined />,
  applied: <CheckCircleOutlined />,
  saving: <LoadingOutlined spin />,
  error: <CloseCircleOutlined />,
  unset: <MinusCircleOutlined />,
  pending_restart: <CheckCircleOutlined />
};

/**
 * 统一设置状态标签：明确区分未保存、已保存/已应用、保存中、保存失败、未设定等状态。
 * 强制包含图标与中文文本，不依赖纯颜色；使用完整 1px 发丝边框，无左侧色条。
 */
export const SettingStatusTag = memo(function SettingStatusTag({
  status,
  label,
  detail,
  compact = false,
  live,
  className,
  style
}: SettingStatusTagProps) {
  const text = label ?? DEFAULT_LABELS[status];
  const resolvedLive = live ?? (status === 'error' ? 'assertive' : 'polite');
  const role = status === 'error' ? 'alert' : 'status';
  const ariaLabel = typeof text === 'string'
    ? (detail ? `${text}：${detail}` : text)
    : detail;

  return (
    <span
      className={[
        'hos-setting-status-tag',
        `hos-setting-status-tag--${status}`,
        compact ? 'hos-setting-status-tag--compact' : '',
        className
      ].filter(Boolean).join(' ')}
      role={role}
      aria-live={resolvedLive}
      aria-label={ariaLabel}
      title={detail}
      data-status={status}
      style={style}
    >
      <span className="hos-setting-status-tag-icon" aria-hidden="true">
        {STATE_ICONS[status]}
      </span>
      <span className="hos-setting-status-tag-text">{text}</span>
    </span>
  );
});

export default SettingStatusTag;
