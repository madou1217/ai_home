import { Modal } from 'antd';
import type { ReactNode } from 'react';

export interface ConfirmActionOptions {
  title: ReactNode;
  content?: ReactNode;
  okText?: string;
  cancelText?: string;
  danger?: boolean;
}

/**
 * 以 Promise 形式弹出 HUD 风格确认框，替代浏览器原生 window.confirm。
 * 主题由 AntdThemeProvider 通过 ConfigProvider.holderRender 注入；
 * 确认返回 true，取消 / 关闭返回 false。
 */
export function confirmAction({
  title,
  content,
  okText = '确认',
  cancelText = '取消',
  danger = false,
}: ConfirmActionOptions): Promise<boolean> {
  return new Promise((resolve) => {
    Modal.confirm({
      title,
      content,
      okText,
      cancelText,
      okButtonProps: danger ? { danger: true } : undefined,
      onOk: () => resolve(true),
      onCancel: () => resolve(false),
    });
  });
}
