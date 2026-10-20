// 捕获范围选择：设置页与聊天录制设置弹窗共用。
// 只负责受控展示，偏好持久化由调用方完成。

import { Segmented } from 'antd';
import {
  CAPTURE_SCOPE_OPTIONS,
  type CaptureScope
} from './capture-preferences';

interface Props {
  value: CaptureScope;
  onChange: (next: CaptureScope) => void;
  compact?: boolean;
}

export function captureScopeDescription(scope: CaptureScope): string {
  return CAPTURE_SCOPE_OPTIONS.find((option) => option.value === scope)?.description ?? '';
}

export default function CaptureScopeFields({ value, onChange, compact = false }: Props) {
  return (
    <Segmented
      size={compact ? 'small' : 'middle'}
      value={value}
      aria-label="捕获范围"
      options={CAPTURE_SCOPE_OPTIONS.map((option) => ({
        label: option.label,
        value: option.value
      }))}
      onChange={(next) => onChange(next as CaptureScope)}
    />
  );
}
