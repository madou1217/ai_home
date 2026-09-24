import { memo, type CSSProperties, type ReactNode } from 'react';
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  ExclamationCircleOutlined,
  InfoCircleOutlined
} from '@ant-design/icons';
import './InlineNote.css';

export type InlineNoteTone = 'info' | 'success' | 'warning' | 'error';

export interface InlineNoteProps {
  tone?: InlineNoteTone;
  /** 主文案（13px）。 */
  children: ReactNode;
  /** 可选的补充说明，紧跟主文案之后换行显示（12px muted）。 */
  description?: ReactNode;
  /** 行尾操作（例如关闭 / 重试的文字按钮）。 */
  action?: ReactNode;
  icon?: ReactNode;
  className?: string;
  style?: CSSProperties;
}

const TONE_ICON: Record<InlineNoteTone, ReactNode> = {
  info: <InfoCircleOutlined />,
  success: <CheckCircleOutlined />,
  warning: <ExclamationCircleOutlined />,
  error: <CloseCircleOutlined />
};

/**
 * 行内提示：取代大块 Alert（AGENTS.md「UI Visual Constraints」/ DESIGN.md §6）。
 * 图标 + 13px 文字，无整块彩底；状态只着色图标。保留 role 语义供读屏器识别。
 */
export const InlineNote = memo(function InlineNote({
  tone = 'info',
  children,
  description,
  action,
  icon,
  className,
  style
}: InlineNoteProps) {
  const role = tone === 'error' || tone === 'warning' ? 'alert' : 'note';
  return (
    <div
      className={`hos-inline-note hos-inline-note--${tone}${className ? ` ${className}` : ''}`}
      role={role}
      style={style}
    >
      <span className="hos-inline-note-icon" aria-hidden="true">{icon ?? TONE_ICON[tone]}</span>
      <div className="hos-inline-note-body">
        <span className="hos-inline-note-text">{children}</span>
        {description ? <span className="hos-inline-note-desc">{description}</span> : null}
      </div>
      {action ? <span className="hos-inline-note-action">{action}</span> : null}
    </div>
  );
});

export default InlineNote;
