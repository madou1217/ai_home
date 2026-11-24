import type { ReactNode } from 'react';
import { Tooltip } from 'antd';
import SettingStatusTag, { type SettingStatusState } from '@/components/ui/SettingStatusTag';
import ToolkitWarningDot from './ToolkitWarningDot';

export interface ManagedResourceDetail {
  label: string;
  value: ReactNode;
  tooltip?: ReactNode;
  muted?: boolean;
  ellipsis?: boolean;
}

export interface ManagedResourceStatusBadge {
  status: SettingStatusState;
  label: string;
  detail?: string;
}

interface ManagedResourceCardProps {
  resourceId: string;
  name: string;
  installed: boolean;
  icon: ReactNode;
  /** 可覆盖默认“已安装 / 未安装”状态（如“更新中 / 失败 / 已启用”）。 */
  statusBadge?: ManagedResourceStatusBadge;
  badges?: ReactNode;
  warning?: string;
  details?: ManagedResourceDetail[];
  actions: ReactNode;
  footer?: ReactNode;
  className?: string;
}

/**
 * 应用、终端和运行环境共用的资源卡骨架。
 * 统一显式文本状态标签、紧凑元信息行和语义动作区。
 */
export default function ManagedResourceCard({
  resourceId,
  name,
  installed,
  icon,
  statusBadge,
  badges,
  warning,
  details = [],
  actions,
  footer,
  className = ''
}: ManagedResourceCardProps) {
  const cardClassName = [
    'toolkit-app-card',
    'hud-panel',
    'hud-panel--sm',
    'toolkit-managed-resource-card',
    installed ? 'installed' : 'uninstalled',
    className
  ].filter(Boolean).join(' ');

  const resolvedBadge: ManagedResourceStatusBadge = statusBadge ?? (
    installed
      ? { status: 'saved', label: '已安装' }
      : { status: 'unset', label: '未安装' }
  );

  return (
    <article className={cardClassName} data-resource-id={resourceId}>
      <div>
        <div className="toolkit-card-header">
          <div className="toolkit-card-title-group">
            {icon}
            <div>
              <h3 className="toolkit-card-title" title={name}>{name}</h3>
              <div className="toolkit-card-tags">
                <SettingStatusTag
                  status={resolvedBadge.status}
                  label={resolvedBadge.label}
                  detail={resolvedBadge.detail}
                  compact
                />
                {badges}
              </div>
            </div>
          </div>
          <ToolkitWarningDot warning={warning} />
        </div>
        {details.length ? (
          <dl className="toolkit-card-body">
            {details.map((detail) => {
              const value = (
                <span className={`toolkit-detail-value${detail.muted ? ' is-uninstalled' : ''}${detail.ellipsis ? ' is-truncated' : ''}`}>
                  {detail.value}
                </span>
              );
              return (
                <div className="toolkit-detail-row" key={detail.label}>
                  <dt className="toolkit-detail-label">{detail.label}</dt>
                  <dd className="toolkit-detail-value-wrap">
                    {detail.tooltip ? <Tooltip title={detail.tooltip}>{value}</Tooltip> : value}
                  </dd>
                </div>
              );
            })}
          </dl>
        ) : null}
      </div>
      <div className="toolkit-card-actions">
        <div className="toolkit-resource-actions">{actions}</div>
        {footer ? <div className="toolkit-resource-footer">{footer}</div> : null}
      </div>
    </article>
  );
}
