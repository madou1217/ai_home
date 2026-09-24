import { memo, type ReactNode } from 'react';
import styles from './SettingsGroupCard.module.css';

export interface SettingsItemProps {
  icon?: ReactNode;
  title: string;
  subtitle?: string;
  action?: ReactNode;
  danger?: boolean;
  onClick?: () => void;
}

export interface SettingsGroupCardProps {
  title?: string;
  description?: string;
  children: ReactNode;
}

export const SettingsItem = memo(function SettingsItem({
  icon,
  title,
  subtitle,
  action,
  danger = false,
  onClick,
}: SettingsItemProps) {
  return (
    <div
      className={`${styles.itemRow} ${onClick ? styles.itemClickable : ''}`}
      onClick={onClick}
    >
      {icon && <div className={styles.itemIconWrapper}>{icon}</div>}
      <div className={styles.itemContent}>
        <span className={`${styles.itemTitle} ${danger ? styles.itemDanger : ''}`}>{title}</span>
        {subtitle && <span className={styles.itemSubtitle}>{subtitle}</span>}
      </div>
      {action && <div className={styles.itemAction}>{action}</div>}
    </div>
  );
});

/**
 * 设置分组卡片：标题 + 说明 + 一组设置行（发丝线分隔），外观与设置页其他卡片一致。
 */
export const SettingsGroupCard = memo(function SettingsGroupCard({
  title,
  description,
  children,
}: SettingsGroupCardProps) {
  return (
    <div className={styles.groupContainer}>
      {(title || description) && (
        <div className={styles.groupHeader}>
          {title && <h3 className={styles.groupTitle}>{title}</h3>}
          {description && <p className={styles.groupDescription}>{description}</p>}
        </div>
      )}
      <div className={styles.islandCard}>
        {children}
      </div>
    </div>
  );
});

export default SettingsGroupCard;
