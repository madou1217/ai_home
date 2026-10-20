// 水印设置控件：开关 + Provider 选择 + 模型文本。
// 水印由捕获域在编码前统一绘制，这里只负责受控取值。

import { Input, Select, Switch } from 'antd';
import { providerIds, providerNames } from '@/providers/catalog';
import type { CaptureWatermarkSettings } from './watermark';
import styles from './recording-settings.module.css';

interface Props {
  value: CaptureWatermarkSettings;
  onChange: (next: CaptureWatermarkSettings) => void;
  compact?: boolean;
}

const PROVIDER_OPTIONS = providerIds.map((id) => ({
  value: providerNames[id] || id,
  label: providerNames[id] || id
}));

export default function WatermarkSettingsFields({ value, onChange, compact = false }: Props) {
  const update = (patch: Partial<CaptureWatermarkSettings>) => {
    onChange({ ...value, ...patch });
  };

  return (
    <div className={`${styles.fields} ${compact ? styles.compact : ''}`}>
      <span className={styles.fieldGroup}>
        <Switch
          size="small"
          checked={value.enabled}
          aria-label="启用水印"
          onChange={(enabled) => update({ enabled })}
        />
        <span className={styles.fieldLabel}>水印</span>
      </span>
      <Select
        size="small"
        allowClear
        showSearch
        optionFilterProp="label"
        style={{ width: 132 }}
        placeholder="Provider"
        aria-label="水印 Provider"
        disabled={!value.enabled}
        value={value.provider || undefined}
        options={PROVIDER_OPTIONS}
        onChange={(provider?: string) => update({ provider: provider || '' })}
      />
      <Input
        size="small"
        style={{ width: compact ? 150 : 190 }}
        placeholder="模型名（可选）"
        aria-label="水印模型"
        disabled={!value.enabled}
        maxLength={120}
        value={value.model}
        onChange={(event) => update({ model: event.target.value })}
      />
    </div>
  );
}
