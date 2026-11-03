import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, RefObject } from 'react';
import type { FloatingAnchor } from './translation-utils';

type Position = Pick<FloatingAnchor, 'left' | 'top'>;

/** 只管理拖动位置。翻译内容、pin 和开关仍由浮层持有。 */
export function useFloatingPanelPosition(panelRef: RefObject<HTMLDivElement>) {
  const [position, setPosition] = useState<Position | null>(null);
  const [viewportRevision, setViewportRevision] = useState(0);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ id: number; x: number; y: number; left: number; top: number } | null>(null);

  const clamp = useCallback((left: number, top: number): Position => {
    const rect = panelRef.current?.getBoundingClientRect();
    return {
      left: Math.max(8, Math.min(left, window.innerWidth - (rect?.width || 380) - 8)),
      top: Math.max(8, Math.min(top, window.innerHeight - (rect?.height || 220) - 8)),
    };
  }, [panelRef]);

  const resetPosition = useCallback(() => { drag.current = null; setDragging(false); setPosition(null); }, []);
  const endDrag = () => { drag.current = null; setDragging(false); };

  // 流式译文增高后仍保持整张面板可达，不把标题或关闭按钮留到视口外。
  useLayoutEffect(() => {
    setPosition((previous) => {
      if (!previous) return previous;
      const next = clamp(previous.left, previous.top);
      return next.left === previous.left && next.top === previous.top ? previous : next;
    });
  });

  useEffect(() => {
    const resize = () => {
      setViewportRevision((revision) => revision + 1);
      setPosition((previous) => previous ? clamp(previous.left, previous.top) : null);
    };
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, [clamp]);

  return {
    position,
    viewportRevision,
    dragging,
    resetPosition,
    /** 将面板移到视口顶部，同时保留用户调整过的横向位置。 */
    pinToTop: () => {
      const rect = panelRef.current?.getBoundingClientRect();
      if (!rect) return;
      setPosition(clamp(rect.left, 12));
    },
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0 || (event.target as Element).closest('button, input, [role="combobox"], [data-panel-actions]')) return;
      const rect = panelRef.current?.getBoundingClientRect();
      if (!rect) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      setDragging(true);
      drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
    },
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => {
      const active = drag.current;
      if (!active || active.id !== event.pointerId) return;
      setPosition(clamp(active.left + event.clientX - active.x, active.top + event.clientY - active.y));
    },
    onPointerUp: endDrag,
    onPointerCancel: endDrag,
    onLostPointerCapture: endDrag,
  };
}
