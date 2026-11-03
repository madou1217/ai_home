// 默认预览设备选择器：聊天录制确认框与设置页共用同一份偏好。

import { DesktopOutlined, MobileOutlined } from '@ant-design/icons';
import { Segmented } from 'antd';
import type { CapturePreviewDevice } from './types';

interface Props {
  value: CapturePreviewDevice;
  onChange: (value: CapturePreviewDevice) => void;
}

const DEVICE_OPTIONS = [
  {
    value: 'desktop',
    label: (
      <>
        <DesktopOutlined /> PC 预览
      </>
    )
  },
  {
    value: 'mobile',
    label: (
      <>
        <MobileOutlined /> 手机预览
      </>
    )
  }
];

export default function PreviewDeviceFields({ value, onChange }: Props) {
  return (
    <Segmented
      size="small"
      value={value}
      options={DEVICE_OPTIONS}
      onChange={(next) => onChange(next as CapturePreviewDevice)}
    />
  );
}
