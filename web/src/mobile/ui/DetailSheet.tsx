import { CloseOutlined } from '@ant-design/icons';
import { Drawer } from 'antd';
import type { ReactNode } from 'react';

interface Props {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  /** 可选 HUD 代号，显示在标题上方 */
  code?: string;
  children: ReactNode;
  footer?: ReactNode;
  /** 高度上限（默认 85dvh，内容自适应） */
  maxHeight?: string;
  destroyOnClose?: boolean;
}

/**
 * 点按展开的底部详情抽屉：切角顶边 + 拖拽条 + HUD 标题。
 * 基于 antd Drawer（焦点管理、Esc、遮罩点击关闭都由 antd 负责）。
 */
export default function DetailSheet({
  open,
  onClose,
  title,
  code,
  children,
  footer,
  maxHeight = '85dvh',
  destroyOnClose = true,
}: Props) {
  return (
    <Drawer
      open={open}
      onClose={onClose}
      placement="bottom"
      height="auto"
      closable={false}
      destroyOnHidden={destroyOnClose}
      rootClassName="mhud-sheet"
      styles={{ wrapper: { maxHeight }, body: { padding: 0 } }}
      title={null}
      footer={footer ? <div className="mhud-sheet__footer">{footer}</div> : null}
    >
      <div className="mhud-sheet__handle" aria-hidden="true" />
      <div className="mhud-sheet__head">
        <div className="mhud-sheet__titles">
          {code ? <span className="mhud-sheet__code">{code}</span> : null}
          <span className="mhud-sheet__title">{title}</span>
        </div>
        <button type="button" className="mhud-icon-btn" aria-label="关闭" onClick={onClose}>
          <CloseOutlined />
        </button>
      </div>
      <div className="mhud-sheet__body">{children}</div>
    </Drawer>
  );
}
