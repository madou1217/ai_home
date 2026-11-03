import { useEffect, useRef, useState } from 'react';

export const COLLAPSE_EXIT_MS = 170;

export interface CollapsePresence {
  /** 内容是否需要挂在 DOM 里（收起动画播完后卸载，长会话不会因为折叠留下大块隐藏内容） */
  present: boolean;
  /** 是否处于展开态（对应 CSS 的 1fr；收起时先回到 0fr，播完再卸载） */
  expanded: boolean;
}

/**
 * 折叠/展开的内容存在性状态机。
 *
 * 目标：展开时内容从 0 高度平滑撑开，收起时先收回 0 高度再卸载——而不是 `{open && node}` 的硬切。
 * 因此把「是否在 DOM 里」（present）与「是否撑开」（expanded）分开：
 *   · open:  true  -> 立即 present，下一帧再 expanded（先以 0fr 挂载，才能过渡到 1fr）
 *   · open: false  -> 立即 expanded=false，等退出时长后 present=false（卸载）
 * 过渡本身由 .aih-reveal 的 grid-template-rows 完成（见 styles/motion.css），这里只管理挂载。
 */
export function useCollapsePresence(open: boolean, exitMs = COLLAPSE_EXIT_MS): CollapsePresence {
  const [present, setPresent] = useState(open);
  const [expanded, setExpanded] = useState(open);
  const presentRef = useRef(open);
  presentRef.current = present;
  const expandedRef = useRef(open);
  expandedRef.current = expanded;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (open) {
      setPresent(true);
      // 首次挂载就处于展开态：不需要再补帧（否则每个常开事件块都要多跑两次 setState）。
      if (expandedRef.current) return undefined;
      // 两帧内从 0fr 过渡到 1fr：同一帧里既挂载又撑开会跳过过渡。
      let inner = 0;
      const outer = requestAnimationFrame(() => {
        inner = requestAnimationFrame(() => setExpanded(true));
      });
      return () => {
        cancelAnimationFrame(outer);
        if (inner) cancelAnimationFrame(inner);
      };
    }
    setExpanded(false);
    expandedRef.current = false;
    if (!presentRef.current) return undefined;
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setPresent(false);
    }, exitMs);
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [open, exitMs]);

  return { present, expanded };
}
