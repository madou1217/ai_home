import type { ReactNode } from 'react';
import { Tag, Tooltip } from 'antd';

export interface ManagedResourceDetail {
  label: string;
  value: ReactNode;
  tooltip?: ReactNode;
  muted?: boolean;
}

interface ManagedResourceCardProps {
  resourceId: string;
  name: string;
  installed: boolean;
  icon: ReactNode;
  badges?: ReactNode;
  details?: ManagedResourceDetail[];
  actions: ReactNode;
  footer?: ReactNode;
  className?: string;
}

/**
 * 应用、终端和运行环境共用的资源卡骨架。
 * 调用方只提供领域数据与动作，身份、状态、详情和生命周期操作的布局保持一致。
 */
export default function ManagedResourceCard({
  resourceId,
  name,
  installed,
  icon,
  badges,
  details = [],
  actions,
  footer,
  className = ''
}: ManagedResourceCardProps) {
  const cardClassName = [
    'toolkit-app-card',
    'toolkit-managed-resource-card',
    installed ? 'installed' : 'uninstalled',
    className
  ].filter(Boolean).join(' ');

  return (
    <article className={cardClassName} data-resource-id={resourceId}>
      <div>
        <div className="toolkit-card-header">
          <div className="toolkit-card-title-group">
            {icon}
            <div>
              <h3 className="toolkit-card-title">{name}</h3>
              <div className="toolkit-card-tags">
                <Tag color={installed ? 'success' : 'default'}>{installed ? '已安装' : '未安装'}</Tag>
                {badges}
              </div>
            </div>
          </div>
        </div>
        {details.length ? (
          <dl className="toolkit-card-body">
            {details.map((detail) => {
              const value = (
                <span className={`toolkit-detail-value${detail.muted ? ' is-uninstalled' : ''}`}>
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
