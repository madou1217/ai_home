import { useEffect, useRef } from 'react';
import { triggerHapticFeedback } from '@/pages/chat-page-hooks';

/**
 * HarmonyOS 6 移动端触顶/触底物理阻尼与微振动触觉反馈
 */
export function useMobileOverscrollFeedback(containerRef: React.RefObject<HTMLElement | null>) {
  const triggeredRef = useRef({ top: false, bottom: false });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    let startY = 0;

    const handleTouchStart = (e: globalThis.TouchEvent) => {
      startY = e.touches[0]?.clientY || 0;
      triggeredRef.current = { top: false, bottom: false };
    };

    const handleTouchMove = (e: globalThis.TouchEvent) => {
      const currentY = e.touches[0]?.clientY || 0;
      const dy = currentY - startY;

      // 触顶下拉阻尼
      if (el.scrollTop <= 0 && dy > 40 && !triggeredRef.current.top) {
        triggeredRef.current.top = true;
        triggerHapticFeedback([10, 30, 10]);
      }

      // 触底上拉阻尼
      const isBottom = Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop) <= 2;
      if (isBottom && dy < -40 && !triggeredRef.current.bottom) {
        triggeredRef.current.bottom = true;
        triggerHapticFeedback(12);
      }
    };

    el.addEventListener('touchstart', handleTouchStart, { passive: true });
    el.addEventListener('touchmove', handleTouchMove, { passive: true });

    return () => {
      el.removeEventListener('touchstart', handleTouchStart);
      el.removeEventListener('touchmove', handleTouchMove);
    };
  }, [containerRef]);
}

export default useMobileOverscrollFeedback;
