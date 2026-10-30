import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
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
 * 超过这个高度的内容不做逐帧高度插值：grid-template-rows 过渡每一帧都会重排子树，
 * 上千像素的工具输出 / diff 在长会话里足够把一帧拖过 16ms。这种情况改成「高度瞬时切换 +
 * 内容淡入」，视觉上仍是展开而不是硬切，但完全不产生逐帧布局。
 */
const TALL_CONTENT_PX = 1200;

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
  const innerRef = useRef<HTMLDivElement | null>(null);
  const [tall, setTall] = useState(false);

  // 展开前测一次内容高度（scrollHeight 在 0fr 裁剪下仍返回真实内容高度），只触发一次布局。
  useLayoutEffect(() => {
    if (!open || !innerRef.current) return;
    const next = innerRef.current.scrollHeight > TALL_CONTENT_PX;
    setTall((previous) => (previous === next ? previous : next));
  }, [open, present]);

  if (!present && !keepMounted) return null;
  const classes = [
    'aih-reveal',
    expanded ? 'aih-reveal-open' : 'aih-reveal-closed',
    className || ''
  ].filter(Boolean).join(' ');
  return (
    <div
      className={classes}
      data-tall={tall ? 'true' : undefined}
      style={{ '--aih-reveal-ms': `${exitMs}ms` } as CSSProperties}
      aria-hidden={open ? undefined : true}
    >
      <div ref={innerRef} className={`aih-reveal-inner${innerClassName ? ` ${innerClassName}` : ''}`}>{children}</div>
    </div>
  );
}
