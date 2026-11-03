import type { ReactNode } from 'react';
import {
  DeleteOutlined,
  DownloadOutlined,
  ReloadOutlined
} from '@ant-design/icons';
import { Tooltip } from 'antd';
import Button, { type AppButtonProps } from '@/components/ui/AppButton';

export type InstallLifecycleActionName = 'install' | 'update' | 'uninstall';

const ACTION_META: Record<InstallLifecycleActionName, { label: string; icon: ReactNode }> = {
  install: { label: '安装', icon: <DownloadOutlined /> },
  update: { label: '更新', icon: <ReloadOutlined /> },
  uninstall: { label: '卸载', icon: <DeleteOutlined /> }
};

export interface InstallLifecycleActionProps
  extends Omit<AppButtonProps, 'children' | 'icon'> {
  action: InstallLifecycleActionName;
  children?: ReactNode;
  iconOnly?: boolean;
  tooltip?: ReactNode;
}

/**
 * Toolkit 所有安装生命周期操作的唯一视觉入口。
 * 文案、图标和卸载危险态在这里保持一致，调用方只声明动作本身。
 */
export default function InstallLifecycleAction({
  action,
  children,
  danger,
  iconOnly = false,
  tooltip,
  type,
  ...props
}: InstallLifecycleActionProps) {
  const meta = ACTION_META[action];
  const isUninstall = action === 'uninstall';
  const accessibleLabel = props['aria-label'] || meta.label;
  const buttonType = type || (!iconOnly && action === 'install' ? 'primary' : 'default');

  const button = (
    <Button
      {...props}
      aria-label={iconOnly ? accessibleLabel : props['aria-label']}
      danger={danger || isUninstall}
      type={buttonType}
      shape={iconOnly ? 'circle' : props.shape}
      icon={meta.icon}
    >
      {iconOnly ? null : (children || meta.label)}
    </Button>
  );

  return iconOnly ? <Tooltip title={tooltip ?? accessibleLabel}>{button}</Tooltip> : button;
}
