import { useLayoutEffect, useRef } from 'react';

const FLIP_KEY_ATTR = 'data-flip-key';
const FLIP_MS = 220;
const ENTER_MS = 180;
const FADE_MS = 160;
/** 逐项补间的上限：超过它（或调用方指定 fade 模式）改成整个容器淡入，零逐项开销。 */
const MAX_FLIP_ITEMS = 80;

type FlipMode = 'auto' | 'fade';

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

export interface FlipReorderOptions {
  /**
   * 'auto'（默认）：小列表逐项 FLIP，长列表自动降级为容器淡入。
   * 'fade'：永远不逐项补间，只在条目顺序真的变了时把容器淡入一次——给表格用
   * （<tr> 上的 transform 会破坏固定列/粘性列，而且行数不受控）。
   */
  mode?: FlipMode;
}

/**
 * 列表重排（排序、筛选、插入）的位移过渡。
 *
 * 用法：容器挂 ref，子项带 `data-flip-key`（稳定主键）。每次渲染提交后测量一遍子项位置，
 * 下一次提交时若同一 key 的位置变了，就先把它平移回旧位置再补间回来——元素是「滑」到新位置的，
 * 而不是瞬间跳过去。位置以容器左上角为原点，页面滚动不会误触发。
 *
 * 掉帧防护（逐帧预算）：
 *  - 先读完所有矩形再统一开动画，读写不交错，一次提交只强制一次 layout；
 *  - 只在**顺序真的变了**时才动，纯数据刷新（轮询更新状态文字）不产生任何动画和测量；
 *  - 条目数超过 MAX_FLIP_ITEMS 直接走容器淡入（opacity 走合成器），不再逐项 rect；
 *  - 容器不可见（未挂载 / display:none）时不测量。
 */
export function useFlipReorder<T extends HTMLElement = HTMLDivElement>(
  signature?: unknown,
  options?: FlipReorderOptions
) {
  const ref = useRef<T | null>(null);
  const previous = useRef<Map<string, RectSnapshot>>(new Map());
  const previousOrder = useRef<string[]>([]);
  const animations = useRef<Animation[]>([]);
  // 不传 signature 时退化为「每次渲染都测量」：用自增序号保证依赖值每帧都变。
  const stamps = useRef(0);
  stamps.current += 1;
  const dep = signature === undefined ? `render:${stamps.current}` : signature;
  const mode = options?.mode ?? 'auto';

  useLayoutEffect(() => {
    const container = ref.current;
    // 容器没渲染（空态 / 条件分支）或不可见：旧坐标失去参照，下次出现时按首屏处理。
    if (!container || container.getClientRects().length === 0) {
      previous.current.clear();
      previousOrder.current = [];
      return undefined;
    }
    // 收起状态的 .aih-reveal（0fr）里的项位置不可信：不测量，等真正展开后再按「新项」处理，
    // 避免解折叠时整列从压扁位置滑出来。先整体查一次，没有收起面板时跳过逐项 closest。
    const hasCollapsedReveal = container.querySelector('.aih-reveal:not(.aih-reveal-open)') !== null;
    const nodes = Array.from(container.querySelectorAll<HTMLElement>(`[${FLIP_KEY_ATTR}]`))
      .filter((node) => !hasCollapsedReveal || !node.closest('.aih-reveal:not(.aih-reveal-open)'));
    const keys: string[] = [];
    for (const node of nodes) {
      const key = node.getAttribute(FLIP_KEY_ATTR);
      if (key) keys.push(key);
    }

    // 顺序是否真的变了：O(n) 字符串比较且遇到第一处不同就停，完全不触发 layout。
    const before = previousOrder.current;
    const firstCommit = before.length === 0;
    let orderChanged = keys.length !== before.length;
    if (!orderChanged) {
      for (let index = 0; index < keys.length; index += 1) {
        if (keys[index] !== before[index]) {
          orderChanged = true;
          break;
        }
      }
    }
    previousOrder.current = keys;

    const reduce = prefersReducedMotion();
    const useFade = mode === 'fade' || nodes.length > MAX_FLIP_ITEMS;

    if (useFade) {
      // 逐项坐标不再维护（下次可能从小列表切回来，按首屏处理）
      previous.current.clear();
      for (const animation of animations.current) animation.cancel();
      animations.current = [];
      if (!reduce && orderChanged && !firstCommit && nodes.length > 0) {
        animations.current.push(container.animate(
          [{ opacity: 0.6 }, { opacity: 1 }],
          { duration: FADE_MS, easing: 'cubic-bezier(0.2, 0, 0, 1)' }
        ));
      }
      return undefined;
    }

    // —— 逐项 FLIP：先读完（一次 layout），再统一写，避免读写交错反复强制重排 ——
    const origin = container.getBoundingClientRect();
    const points: Array<{ node: HTMLElement; key: string; left: number; top: number }> = [];
    for (const node of nodes) {
      const key = node.getAttribute(FLIP_KEY_ATTR);
      if (!key) continue;
      const rect = node.getBoundingClientRect();
      points.push({ node, key, left: rect.left - origin.left, top: rect.top - origin.top });
    }
    const next = new Map<string, RectSnapshot>();
    for (const point of points) next.set(point.key, { left: point.left, top: point.top });

    for (const animation of animations.current) animation.cancel();
    animations.current = [];
    if (!reduce) {
      for (const point of points) {
        const previousPoint = previous.current.get(point.key);
        if (previousPoint) {
          const dx = previousPoint.left - point.left;
          const dy = previousPoint.top - point.top;
          if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
          animations.current.push(point.node.animate(
            [
              { transform: `translate(${dx}px, ${dy}px)` },
              { transform: 'translate(0, 0)' }
            ],
            { duration: FLIP_MS, easing: 'cubic-bezier(0.2, 0, 0, 1)' }
          ));
        } else if (previous.current.size > 0) {
          // 首屏（previous 为空）不做入场动画，避免和页面的 stagger 进场叠加。
          animations.current.push(point.node.animate(
            [
              { opacity: 0, transform: 'translateY(4px)' },
              { opacity: 1, transform: 'translateY(0)' }
            ],
            { duration: ENTER_MS, easing: 'cubic-bezier(0.2, 0, 0, 1)' }
          ));
        }
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
    previousOrder.current = [];
  }, []);

  return ref;
}
