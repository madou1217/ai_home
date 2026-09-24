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
  /**
   * 数值发光色调（纯展示）：'status' 跟随 status（默认）；'accent' 为中性青色，
   * 用于运行时长 / 吞吐这类本身不代表健康度的数值。
   */
  valueTone?: 'status' | 'accent';
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
  valueTone = 'status',
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
  const ledClass =
    status === 'healthy'
      ? 'hud-led--ok'
      : status === 'warning'
      ? 'hud-led--warn'
      : status === 'neutral'
      ? ''
      : 'hud-led--err';
  const valueToneClass =
    valueTone === 'accent'
      ? `${styles.valueAccent} hud-glow`
      : status === 'healthy'
      ? `${styles.valueSuccess} hud-glow-success`
      : status === 'warning'
      ? `${styles.valueWarning} hud-glow-warning`
      : status === 'neutral'
      ? ''
      : `${styles.valueDanger} hud-glow-danger`;

  return (
    <div
      className={`${styles.widgetCard} ${span === 2 ? styles.spanTwo : ''} ${onClick ? styles.clickable : ''}`}
      onClick={onClick}
    >
      <div className={styles.widgetHeader}>
        <span className={`${styles.widgetTitle} hud-label`}>{title}</span>
        {icon && <div className={styles.widgetIcon}>{icon}</div>}
      </div>

      <div className={styles.widgetBody}>
        <strong className={`${styles.widgetValue} hud-display ${valueToneClass}`}>{value}</strong>
        {subtitle && <span className={styles.widgetSubtitle}>{subtitle}</span>}
      </div>

      <div className={styles.widgetFooter}>
        <div className={`${styles.statusDotWrapper} ${statusClass}`}>
          <span className={`hud-led ${ledClass}`} />
          <span>{status === 'healthy' ? '运行正常' : status === 'warning' ? '存在告警' : status === 'neutral' ? '暂无数据' : '不可用'}</span>
        </div>
        {trend && <span className={styles.trendText}>{trend}</span>}
      </div>
    </div>
  );
});

/**
 * KPI 条（web/DESIGN.md §6 / §7.1，HUD）：全局 .hud-kpi-strip 切角面板 + 角标，单元格之间 1px 发丝线分隔；
 * 桌面 4 列、<1024px 2x2、手机单列。数据契约（widgets）保持不变。
 */
export const ServiceWidgetGrid = memo(function ServiceWidgetGrid({
  widgets,
}: ServiceWidgetGridProps) {
  return (
    <div className={`${styles.gridContainer} hud-kpi-strip`}>
      {widgets.map((w, idx) => (
        <ServiceWidget key={`${w.title}-${idx}`} {...w} />
      ))}
    </div>
  );
});

export default ServiceWidgetGrid;
