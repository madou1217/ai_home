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
 * HarmonyOS 6 风格分组设置圆角岛 (ArkUI Grouped Settings Island)
 * 采用 24px Squircle 超级圆角、通透亚克力毛玻璃、左置灵动图标与内敛分割线
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
