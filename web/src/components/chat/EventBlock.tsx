import { memo, useCallback, useState } from 'react';
import type { ReactNode } from 'react';
import styles from './EventBlock.module.css';

export type EventTone =
  | 'tool'
  | 'thinking'
  | 'plan'
  | 'goal'
  | 'memory'
  | 'notify'
  | 'ask'
  | 'neutral';

export type StatusTone =
  | 'neutral'
  | 'running'
  | 'success'
  | 'attention'
  | 'failed'
  | 'cancelled';

export interface EventStatus {
  label: ReactNode;
  tone?: StatusTone;
  /** running 态会让圆点呼吸 */
  dot?: boolean;
}

interface EventBlockProps {
  /** 事件语义色 */
  tone?: EventTone;
  /** 头部左侧图标 */
  icon?: ReactNode;
  /** 标题 */
  title: ReactNode;
  /** 折叠时显示的预览（单行省略） */
  preview?: ReactNode;
  /** 头部右侧次要信息（数量/路径/耗时等） */
  meta?: ReactNode;
  /** 状态徽章 */
  status?: EventStatus;
  /** 是否可折叠，默认 true。为 false 时常驻展开、无箭头 */
  collapsible?: boolean;
  defaultOpen?: boolean;
  /** 受控展开 */
  open?: boolean;
  onOpenChange?: (next: boolean) => void;
  /** 移动端紧凑模式 */
  dense?: boolean;
  /** body 是否紧贴 header（无分隔线） */
  flushBody?: boolean;
  /** body 去除内边距（代码块/命令输出等需要贴边时） */
  barePadding?: boolean;
  className?: string;
  bodyClassName?: string;
  children?: ReactNode;
  'aria-label'?: string;
}

/** 状态徽章（可单独使用） */
export const StatusBadge = ({ label, tone = 'neutral', dot = false }: EventStatus) => (
  <span className={styles.badge} data-tone={tone}>
    {dot ? <span className={styles.badgeDot} aria-hidden="true" /> : null}
    {label}
  </span>
);

/**
 * 会话事件块统一原语。所有非纯文本事件（工具/思考/计划/目标/记忆/通知/提问）都应基于它，
 * 以获得一致的头部、折叠动效、强调色与几何。详见 web/DESIGN.md §8。
 */
function EventBlock({
  tone = 'tool',
  icon,
  title,
  preview,
  meta,
  status,
  collapsible = true,
  defaultOpen = false,
  open,
  onOpenChange,
  dense = false,
  flushBody = false,
  barePadding = false,
  className,
  bodyClassName,
  children,
  'aria-label': ariaLabel
}: EventBlockProps) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const isControlled = open !== undefined;
  const isOpen = collapsible ? (isControlled ? open : internalOpen) : true;
  const hasBody = children != null && children !== false;
  const clickable = collapsible && hasBody;

  const toggle = useCallback(() => {
    if (!clickable) return;
    const next = !isOpen;
    if (!isControlled) setInternalOpen(next);
    onOpenChange?.(next);
  }, [clickable, isOpen, isControlled, onOpenChange]);

  const HeaderTag = clickable ? 'button' : 'div';

  return (
    <section
      className={`${styles.root}${className ? ` ${className}` : ''}`}
      data-tone={tone}
      data-open={isOpen ? 'true' : 'false'}
      data-dense={dense ? 'true' : 'false'}
      aria-label={ariaLabel}
    >
      <HeaderTag
        type={clickable ? 'button' : undefined}
        className={styles.header}
        data-clickable={clickable ? 'true' : 'false'}
        onClick={clickable ? toggle : undefined}
        aria-expanded={collapsible ? isOpen : undefined}
      >
        {clickable ? (
          <span className={styles.chevron} aria-hidden="true">›</span>
        ) : null}
        {icon ? <span className={styles.icon} aria-hidden="true">{icon}</span> : null}
        <span className={styles.title}>{title}</span>
        {!isOpen && preview ? <span className={styles.preview}>{preview}</span> : <span className={styles.spacer} />}
        {meta ? <span className={styles.meta}>{meta}</span> : null}
        {status ? <StatusBadge {...status} /> : null}
      </HeaderTag>
      {isOpen && hasBody ? (
        <div className={`${styles.body}${flushBody ? ` ${styles.bodyFlush}` : ''}${barePadding ? ` ${styles.bodyBare}` : ''}${bodyClassName ? ` ${bodyClassName}` : ''}`}>
          {children}
        </div>
      ) : null}
    </section>
  );
}

export default memo(EventBlock);
