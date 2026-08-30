import { memo, type ReactNode } from 'react';
import { Space, Tooltip } from 'antd';
import {
  ThunderboltFilled,
  CheckCircleFilled,
  ExclamationCircleFilled,
  CloseCircleFilled,
  CloudServerOutlined,
  AppstoreOutlined,
  LineChartOutlined,
} from '@ant-design/icons';
import styles from './ServiceWidgetGrid.module.css';

export interface ServiceWidgetProps {
  title: string;
  value: string | number;
  subtitle?: string;
  icon?: ReactNode;
  status?: 'healthy' | 'warning' | 'error';
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
          <span>{status === 'healthy' ? '运行正常' : status === 'warning' ? '存在告警' : '不可用'}</span>
        </div>
        {trend && <span className={styles.trendText}>{trend}</span>}
      </div>
    </div>
  );
});

/**
 * HarmonyOS 6 风格万象灵动小组件栅格 (ArkUI Service Widget Grid)
 * 采用 2x2 / 2x4 鸿蒙小组件排版、24px Squircle 超级圆角、高斯模糊与微重力悬浮质感
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
