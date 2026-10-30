import { useLayoutEffect, useRef } from 'react';

const FLIP_KEY_ATTR = 'data-flip-key';
const FLIP_MS = 220;
const ENTER_MS = 180;
/** 列表过长时逐项补间收益很低，直接跳过（移动端 60 个元素的 WAAPI 补间会掉帧）。 */
const MAX_FLIP_ITEMS = 80;

function prefersReducedMotion() {
  if (typeof window === 'undefined') return true;
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (_error) {
    return false;
  }
}

interface RectSnapshot {
  left: number;
  top: number;
}

/**
 * 列表重排（排序、筛选、插入）的 FLIP 位移过渡。
 *
 * 用法：容器挂 ref，子项带 `data-flip-key`（稳定主键）。每次渲染提交后测量一遍子项位置，
 * 下一次提交时若同一 key 的位置变了，就先把它平移回旧位置再补间回来——元素是「滑」到新位置的，
 * 而不是瞬间跳过去。新出现的 key 做一次轻量淡入。位置以容器左上角为原点，页面滚动不会误触发。
 *
 * `signature` 变化只在列表身份变化时重算；不传则每次渲染都检查（仍是 O(可见项)）。
 */
export function useFlipReorder<T extends HTMLElement = HTMLDivElement>(signature?: unknown) {
  const ref = useRef<T | null>(null);
  const previous = useRef<Map<string, RectSnapshot>>(new Map());
  const animations = useRef<Animation[]>([]);
  // 不传 signature 时退化为「每次渲染都测量」：用自增序号保证依赖值每帧都变。
  const stamps = useRef(0);
  stamps.current += 1;
  const dep = signature === undefined ? `render:${stamps.current}` : signature;

  useLayoutEffect(() => {
    const container = ref.current;
    // 容器当前没渲染（空态 / 条件分支）：旧坐标失去参照，下次出现时按首屏处理。
    if (!container) {
      previous.current.clear();
      return undefined;
    }
    // 收起状态的 .aih-reveal（0fr）里的项位置不可信：不测量，等真正展开后再按「新项」处理，
    // 避免解折叠时整列从压扁位置滑出来。
    const nodes = Array.from(container.querySelectorAll<HTMLElement>(`[${FLIP_KEY_ATTR}]`))
      .filter((node) => !node.closest('.aih-reveal:not(.aih-reveal-open)'));
    const origin = container.getBoundingClientRect();
    const next = new Map<string, RectSnapshot>();
    const reduce = prefersReducedMotion();
    const animate = !reduce && nodes.length > 0 && nodes.length <= MAX_FLIP_ITEMS;

    if (animate) {
      for (const animation of animations.current) animation.cancel();
      animations.current = [];
      for (const node of nodes) {
        const key = node.getAttribute(FLIP_KEY_ATTR);
        if (!key) continue;
        const rect = node.getBoundingClientRect();
        const point = { left: rect.left - origin.left, top: rect.top - origin.top };
        next.set(key, point);
        const before = previous.current.get(key);
        if (before) {
          const dx = before.left - point.left;
          const dy = before.top - point.top;
          if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
          animations.current.push(node.animate(
            [
              { transform: `translate(${dx}px, ${dy}px)` },
              { transform: 'translate(0, 0)' }
            ],
            { duration: FLIP_MS, easing: 'cubic-bezier(0.2, 0, 0, 1)' }
          ));
        } else if (previous.current.size > 0) {
          // 首屏（previous 为空）不做入场动画，避免和页面的 stagger 进场叠加。
          animations.current.push(node.animate(
            [
              { opacity: 0, transform: 'translateY(4px)' },
              { opacity: 1, transform: 'translateY(0)' }
            ],
            { duration: ENTER_MS, easing: 'cubic-bezier(0.2, 0, 0, 1)' }
          ));
        }
      }
    } else {
      for (const node of nodes) {
        const key = node.getAttribute(FLIP_KEY_ATTR);
        if (!key) continue;
        const rect = node.getBoundingClientRect();
        next.set(key, { left: rect.left - origin.left, top: rect.top - origin.top });
      }
    }
    previous.current = next;
    return undefined;
  }, [dep]);

  useLayoutEffect(() => () => {
    for (const animation of animations.current) animation.cancel();
    animations.current = [];
    // 容器卸载后旧坐标失去参照，重建时按首屏处理（不做跨页面的假位移）。
    previous.current.clear();
  }, []);

  return ref;
}
