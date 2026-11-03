import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { buildBucketTooltip } from './tooltip';
import type { BucketGranularity, OutcomeBucket } from './types';
import './account-status.css';

type Placement = 'top' | 'bottom';

interface TipState {
  startMs: number;
  bucket: OutcomeBucket | null;
  x: number;
  y: number;
  placement: Placement;
}

/**
 * 90 天 / 24 小时状态条的**单实例**悬浮提示。
 *
 * 为什么不用 antd Tooltip：每个桶一个 Tooltip 会挂 90~114 个 rc-tooltip 实例（context、
 * 事件、motion），展开/收起时整棵子树挂载/卸载就是点击数秒卡顿的来源。这里用容器上的
 * 一次 pointerover 委托 + 一个 portal 提示，DOM 里只有纯 span，展开只改 CSS 行高。
 *
 * 提示内容只在真正悬浮到某个桶时计算（buildBucketTooltip 是纯函数，但原先每帧要为
 * 所有桶算一遍）。
 */
export function useHealthHoverTip(
  granularity: BucketGranularity,
  starts: number[],
  buckets: Array<OutcomeBucket | null>
) {
  const [tip, setTip] = useState<TipState | null>(null);
  const lastIndexRef = useRef<number | null>(null);

  const hide = useCallback(() => {
    lastIndexRef.current = null;
    setTip(null);
  }, []);

  const onPointerOver = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    // 触屏没有 hover；移动端点按不应弹出一个跟随不掉的浮层。
    if (event.pointerType === 'touch') return;
    const cell = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-health-cell]');
    if (!cell) {
      hide();
      return;
    }
    const index = Number(cell.dataset.healthCell);
    if (!Number.isInteger(index) || index < 0 || index >= starts.length) return;
    if (lastIndexRef.current === index) return;
    const rect = cell.getBoundingClientRect();
    const placement: Placement = rect.top > 140 ? 'top' : 'bottom';
    lastIndexRef.current = index;
    setTip({
      startMs: starts[index],
      bucket: buckets[index] || null,
      x: rect.left + rect.width / 2,
      y: placement === 'top' ? rect.top - 8 : rect.bottom + 8,
      placement
    });
  }, [buckets, hide, starts]);

  useEffect(() => {
    if (!tip) return undefined;
    // 滚动/缩放后锚点已经不准，直接收起比追着改位置更便宜。
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    return () => {
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
    };
  }, [tip, hide]);

  const tooltip = tip && typeof document !== 'undefined'
    ? createPortal(<HealthHoverTipCard tip={tip} granularity={granularity} />, document.body)
    : null;

  return { onPointerOver, onPointerLeave: hide, tooltip };
}

function HealthHoverTipCard({ tip, granularity }: { tip: TipState; granularity: BucketGranularity }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const info = buildBucketTooltip(tip.startMs, tip.bucket, granularity);

  // 先渲染到屏幕外，拿到真实尺寸后再夹到视口内；一帧内完成，不会闪。
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const width = node.offsetWidth;
    const height = node.offsetHeight;
    const left = Math.min(Math.max(tip.x - width / 2, 8), Math.max(8, window.innerWidth - width - 8));
    const top = tip.placement === 'top'
      ? Math.max(8, tip.y - height)
      : Math.min(tip.y, Math.max(8, window.innerHeight - height - 8));
    node.style.left = `${left}px`;
    node.style.top = `${top}px`;
  }, [tip]);

  return (
    <div ref={ref} className="account-status-hover-tip" data-placement={tip.placement} role="tooltip">
      <div className="account-status-hover-tip__title">{info.title}</div>
      <div className="account-status-hover-tip__line">{info.summaryLine}</div>
      {info.failureLines.map((line) => (
        <div key={line} className="account-status-hover-tip__line account-status-hover-tip__line--failure">{line}</div>
      ))}
    </div>
  );
}
