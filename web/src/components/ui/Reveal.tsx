import type { CSSProperties, ReactNode } from 'react';
import { useCollapsePresence, COLLAPSE_EXIT_MS } from '@/hooks/use-collapse-presence';

interface RevealProps {
  open: boolean;
  children: ReactNode;
  className?: string;
  /** 内容外层 class（内层才是会被裁剪的内容盒） */
  innerClassName?: string;
  exitMs?: number;
  /** 收起后是否保留在 DOM 里（搜索条这类轻量节点可保留，避免反复挂载） */
  keepMounted?: boolean;
}

/**
 * 展开/收起的内容过渡原语：外层 `.aih-reveal` 用 grid-template-rows 0fr↔1fr 撑开，
 * 内层 `.aih-reveal-inner` 负责 overflow 裁剪（见 styles/motion.css）。
 * 收起动画播完后默认卸载内容；keepMounted 时只收起不卸载（用于需要保存内部状态的轻量面板）。
 */
export default function Reveal({
  open,
  children,
  className,
  innerClassName,
  exitMs = COLLAPSE_EXIT_MS,
  keepMounted = false
}: RevealProps) {
  const { present, expanded } = useCollapsePresence(open, exitMs);
  if (!present && !keepMounted) return null;
  const classes = [
    'aih-reveal',
    expanded ? 'aih-reveal-open' : 'aih-reveal-closed',
    className || ''
  ].filter(Boolean).join(' ');
  return (
    <div
      className={classes}
      style={{ '--aih-reveal-ms': `${exitMs}ms` } as CSSProperties}
      aria-hidden={open ? undefined : true}
    >
      <div className={`aih-reveal-inner${innerClassName ? ` ${innerClassName}` : ''}`}>{children}</div>
    </div>
  );
}
