import { useLayoutEffect } from 'react';

/**
 * 「切换」类交互的统一淡入：同一块区域从 A 换成 B（切会话、切视图）时，
 * 用一次只碰 opacity 的 WAAPI 动画表达「换掉了」，而不是让内容瞬间跳变。
 *
 * 注意：
 * - 此钩子同时被移动端页面引用，保持纯 opacity 后置淡入语义不变；
 * - 若外层已激活预提交 ViewTransition（`html[data-vt-kind]`）、页面隐藏或终端拖拽调尺寸中，
 *   自动跳过后置淡入，杜绝与合成器快照叠加播放。
 */

const lastSwitchKeys = new Map<string, string>();
const activeFadeAnimations = new WeakMap<HTMLElement, Animation>();

export interface SwitchFadeOptions {
  /** 动画时长（ms），默认 180 */
  duration?: number;
  /** 起始不透明度，默认 0.3——不从 0 开始，避免闪白 */
  from?: number;
  /** 上一次 key 的所属分区，默认 'default'（聊天会话切换用它） */
  scope?: string;
}

export function useSwitchFade<E extends HTMLElement>(
  ref: { current: E | null },
  key: string | null | undefined,
  options: SwitchFadeOptions = {}
) {
  const { duration = 180, from = 0.3, scope = 'default' } = options;
  useLayoutEffect(() => {
    const next = key || '';
    if (!next) return;
    const previous = lastSwitchKeys.get(scope);
    lastSwitchKeys.set(scope, next);
    if (!previous || previous === next) return;
    const node = ref.current;
    if (!node || typeof node.animate !== 'function') return;
    const doc = node.ownerDocument;
    let reduce = false;
    try {
      reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch (_error) {
      reduce = false;
    }
    const prevAnim = activeFadeAnimations.get(node);
    let startOpacity = from;
    if (prevAnim) {
      try {
        const currentOpacity = Number.parseFloat(getComputedStyle(node).opacity);
        if (Number.isFinite(currentOpacity) && currentOpacity > 0.05 && currentOpacity < 0.98) {
          startOpacity = currentOpacity;
        }
        prevAnim.cancel();
      } catch (_error) {
        // 忽略取消异常。
      }
      activeFadeAnimations.delete(node);
    }
    if (
      reduce
      || doc.hidden
      || (typeof doc.visibilityState === 'string' && doc.visibilityState !== 'visible')
      || doc.documentElement.classList.contains('aih-terminal-resizing')
      || doc.documentElement.hasAttribute('data-vt-kind')
    ) {
      return;
    }
    const anim = node.animate([{ opacity: startOpacity }, { opacity: 1 }], {
      duration,
      easing: 'cubic-bezier(0.2, 0, 0, 1)',
      fill: 'none'
    });
    activeFadeAnimations.set(node, anim);
    const clear = () => {
      if (activeFadeAnimations.get(node) === anim) {
        activeFadeAnimations.delete(node);
      }
    };
    anim.onfinish = clear;
    anim.oncancel = clear;
  }, [key, ref, duration, from, scope]);
}

export default useSwitchFade;
