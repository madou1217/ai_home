import type { ReactNode } from 'react';
import {
  DeleteOutlined,
  DownloadOutlined,
  ReloadOutlined
} from '@ant-design/icons';
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
}

/**
 * Toolkit 所有安装生命周期操作的唯一视觉入口。
 * 文案、图标和卸载危险态在这里保持一致，调用方只声明动作本身。
 */
export default function InstallLifecycleAction({
  action,
  children,
  danger,
  type,
  ...props
}: InstallLifecycleActionProps) {
  const meta = ACTION_META[action];
  const isUninstall = action === 'uninstall';

  return (
    <Button
      {...props}
      danger={danger || isUninstall}
      type={type || (action === 'install' ? 'primary' : 'default')}
      icon={meta.icon}
    >
      {children || meta.label}
    </Button>
  );
}
