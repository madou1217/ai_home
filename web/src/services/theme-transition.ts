// 主题切换的进场包装：用 View Transitions 做整页交叉淡入。
//
// 为什么不用逐元素 transition：主题翻转改的是 :root 上的 CSS 变量，几乎每个节点都会变色；
// 给 `*` 加 background/color transition 会让一次翻转重排/重绘上万次（账号表、聊天长会话）。
// View Transitions 由浏览器对「旧帧 / 新帧」各做一次快照，过渡在合成器上完成，与 DOM 规模无关。
// 不支持（或用户要求减少动效）时直接切换——零成本降级。

import type { ThemeMode } from '@/services/theme-mode';
import { applyThemeMode } from '@/services/theme-persistence';

type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => void) => { finished: Promise<unknown> };
};

export function applyThemeModeAnimated(mode: ThemeMode): void {
  const doc = typeof document === 'undefined' ? null : (document as ViewTransitionDocument);
  if (!doc || typeof doc.startViewTransition !== 'function') {
    applyThemeMode(mode);
    return;
  }
  let reduce = false;
  try {
    reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (_error) {
    reduce = false;
  }
  if (reduce) {
    applyThemeMode(mode);
    return;
  }
  try {
    doc.startViewTransition(() => applyThemeMode(mode));
  } catch (_error) {
    // 过渡启动失败（例如同一帧内已有进行中的过渡）时退回瞬时切换，主题必须生效。
    applyThemeMode(mode);
  }
}
