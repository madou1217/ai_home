// 水印设置控件：只保留开关。
// provider/model 不属于用户配置，捕获时从当前会话身份自动解析。

import { Switch } from 'antd';
import type { CaptureWatermarkPreference } from './watermark';
import styles from './recording-settings.module.css';

interface Props {
  value: CaptureWatermarkPreference;
  onChange: (next: CaptureWatermarkPreference) => void;
  compact?: boolean;
}

export default function WatermarkSettingsFields({ value, onChange, compact = false }: Props) {
  return (
    <div className={`${styles.fields} ${compact ? styles.compact : ''}`}>
      <span className={styles.fieldGroup}>
        <Switch
          size="small"
          checked={value.enabled}
          aria-label="启用水印"
          onChange={(enabled) => onChange({ enabled })}
        />
        <span className={styles.fieldLabel}>水印</span>
      </span>
    </div>
  );
}
