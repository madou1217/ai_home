import { useLayoutEffect, useRef } from 'react';

/**
 * 「追加一条」的进场：会话里新出现一条消息 / 一行结果时，只有新节点做一次轻量淡入上移，
 * 已经存在的节点不动。
 *
 * 为什么不做在 CSS 里：CSS 挂载动画会把「切会话整批挂载」也动画一遍（长会话几十条同时播），
 * 那不是「追加」，代价也不该付。这里用 keys 的「纯追加」判定（长度增长且前缀一致）区分：
 * - 首屏、加载更早记录、切换会话、重排：前缀不成立或数量超阈值 → 不播；
 * - 一次只追加少量（≤ maxItems）：只对末尾 N 个匹配节点做 opacity/transform，合成器即可完成。
 * resetKey（会话 id）变化时直接重置基线，不把「换会话」误判成追加。
 */

export interface AppendEnterOptions {
  /** 容器内按视觉顺序排列的可动画节点选择器 */
  selector: string;
  /** 一次最多逐项动画几个新节点；超过视作批量挂载，不播 */
  maxItems?: number;
  duration?: number;
  /** 起始上移距离（px） */
  distance?: number;
  /** 起始不透明度 */
  from?: number;
}

const DEFAULT_OPTIONS: Required<Omit<AppendEnterOptions, 'selector'>> = {
  maxItems: 4,
  duration: 220,
  distance: 6,
  from: 0.4
};

export function useAppendEnter<E extends HTMLElement>(
  ref: { current: E | null },
  keys: readonly string[],
  resetKey: string,
  options: AppendEnterOptions
) {
  const { selector, maxItems, duration, distance, from } = { ...DEFAULT_OPTIONS, ...options };
  const previousRef = useRef<readonly string[] | null>(null);
  const ownerRef = useRef(resetKey);

  useLayoutEffect(() => {
    const previous = previousRef.current;
    const ownerChanged = ownerRef.current !== resetKey;
    ownerRef.current = resetKey;
    previousRef.current = keys;
    if (ownerChanged || !previous) return;
    if (keys.length <= previous.length) return;
    const added = keys.length - previous.length;
    if (added > maxItems) return;
    // 只认「纯追加」：已有前缀原样保留，否则是插入/重排/换数据。
    for (let i = 0; i < previous.length; i += 1) {
      if (previous[i] !== keys[i]) return;
    }
    const container = ref.current;
    if (!container || container.getClientRects().length === 0) return;
    let reduce = false;
    try {
      reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch (_error) {
      reduce = false;
    }
    if (reduce) return;
    const nodes = container.querySelectorAll<HTMLElement>(selector);
    for (let i = Math.max(0, nodes.length - added); i < nodes.length; i += 1) {
      nodes[i]?.animate(
        [
          { opacity: from, transform: `translateY(${distance}px)` },
          { opacity: 1, transform: 'none' }
        ],
        { duration, easing: 'cubic-bezier(0.2, 0, 0, 1)' }
      );
    }
  }, [keys, resetKey, ref, selector, maxItems, duration, distance, from]);
}

export default useAppendEnter;
