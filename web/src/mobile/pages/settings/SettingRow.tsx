import type { ReactNode } from 'react';
import styles from './MobileSettings.module.css';

interface Props {
  title: ReactNode;
  subtitle?: ReactNode;
  /** 右侧真实控件（Switch / 按钮），整行 ≥ 56px */
  control?: ReactNode;
  danger?: boolean;
}

/** 设置行：左侧标题 + 说明，右侧控件；发丝分隔，拇指可达。 */
export default function SettingRow({ title, subtitle, control, danger }: Props) {
  return (
    <div className={`${styles.row}${danger ? ` ${styles.rowDanger}` : ''}`}>
      <div className={styles.rowText}>
        <span className={styles.rowTitle}>{title}</span>
        {subtitle ? <span className={styles.rowSub}>{subtitle}</span> : null}
      </div>
      {control ? <div className={styles.rowControl}>{control}</div> : null}
    </div>
  );
}
