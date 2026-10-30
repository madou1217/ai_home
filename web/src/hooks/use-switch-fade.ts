import { useLayoutEffect } from 'react';

/**
 * 「切换」类交互的统一淡入：同一块区域从 A 换成 B（切会话、切视图）时，
 * 用一次只碰 opacity 的 WAAPI 动画表达「换掉了」，而不是让内容瞬间跳变。
 *
 * 为什么记在模块级而不是 ref 里：会话切换在部分聊天外壳里会连带整个组件重挂载，
 * 组件内的上一次 key 会随之丢失；模块级变量在 SPA 生命周期内一直有效。
 * 首次进入（没有上一次 key）不播——首屏由路由进场动画负责，避免叠加。
 */

let lastSwitchKey: string | null = null;

export interface SwitchFadeOptions {
  /** 动画时长（ms），默认 180 */
  duration?: number;
  /** 起始不透明度，默认 0.3——不从 0 开始，避免闪白 */
  from?: number;
}

export function useSwitchFade<E extends HTMLElement>(
  ref: { current: E | null },
  key: string | null | undefined,
  options: SwitchFadeOptions = {}
) {
  const { duration = 180, from = 0.3 } = options;
  useLayoutEffect(() => {
    const next = key || '';
    if (!next) return;
    const previous = lastSwitchKey;
    lastSwitchKey = next;
    if (!previous || previous === next) return;
    const node = ref.current;
    if (!node) return;
    let reduce = false;
    try {
      reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch (_error) {
      reduce = false;
    }
    if (reduce) return;
    node.animate([{ opacity: from }, { opacity: 1 }], {
      duration,
      easing: 'cubic-bezier(0.2, 0, 0, 1)'
    });
  }, [key, ref, duration, from]);
}

export default useSwitchFade;
