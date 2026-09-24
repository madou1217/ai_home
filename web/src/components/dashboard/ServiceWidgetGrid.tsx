import { memo, type ReactNode } from 'react';
import styles from './ServiceWidgetGrid.module.css';

export interface ServiceWidgetProps {
  title: string;
  value: string | number;
  subtitle?: string;
  icon?: ReactNode;
  status?: 'healthy' | 'warning' | 'error' | 'neutral';
  span?: 1 | 2;
  trend?: string;
  onClick?: () => void;
}

export interface ServiceWidgetGridProps {
  widgets: ServiceWidgetProps[];
}

export const ServiceWidget = memo(function ServiceWidget({
  title,
  value,
  subtitle,
  icon,
  status = 'healthy',
  span = 1,
  trend,
  onClick,
}: ServiceWidgetProps) {
  const statusClass =
    status === 'healthy'
      ? styles.statusHealthy
      : status === 'warning'
      ? styles.statusWarning
      : status === 'neutral'
      ? styles.statusNeutral
      : styles.statusError;

  return (
    <div
      className={`${styles.widgetCard} ${span === 2 ? styles.spanTwo : ''} ${onClick ? styles.clickable : ''}`}
      onClick={onClick}
    >
      <div className={styles.widgetHeader}>
        <span className={styles.widgetTitle}>{title}</span>
        {icon && <div className={styles.widgetIcon}>{icon}</div>}
      </div>

      <div className={styles.widgetBody}>
        <strong className={styles.widgetValue}>{value}</strong>
        {subtitle && <span className={styles.widgetSubtitle}>{subtitle}</span>}
      </div>

      <div className={styles.widgetFooter}>
        <div className={`${styles.statusDotWrapper} ${statusClass}`}>
          <span className={styles.statusDot} />
          <span>{status === 'healthy' ? '运行正常' : status === 'warning' ? '存在告警' : status === 'neutral' ? '暂无数据' : '不可用'}</span>
        </div>
        {trend && <span className={styles.trendText}>{trend}</span>}
      </div>
    </div>
  );
});

/**
 * KPI 条（web/DESIGN.md §6 / §7.1）：一个描边表面容器，单元格之间 1px 发丝线分隔；
 * 桌面 4 列、<1024px 2x2、手机单列。数据契约（widgets）保持不变。
 */
export const ServiceWidgetGrid = memo(function ServiceWidgetGrid({
  widgets,
}: ServiceWidgetGridProps) {
  return (
    <div className={styles.gridContainer}>
      {widgets.map((w, idx) => (
        <ServiceWidget key={`${w.title}-${idx}`} {...w} />
      ))}
    </div>
  );
});

export default ServiceWidgetGrid;
