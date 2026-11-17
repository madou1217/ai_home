// 主题切换的进场包装：复用统一的 View Transitions 事务经纪人做整页交叉淡入。
//
// 为什么不用逐元素 transition：主题翻转改的是 :root 上的 CSS 变量，几乎每个节点都会变色；
// 给 `*` 加 background/color transition 会让一次翻转重排/重绘上万次（账号表、聊天长会话）。
// View Transitions 由浏览器对「旧帧 / 新帧」各做一次快照，过渡在合成器上完成，与 DOM 规模无关。
// 与路由/面板 ViewTransition 共享同一套事务协调器：并发触发时前序状态先同步落盘，不丢路由或状态更新，
// 页面隐藏或减少动效下直接同步切换且不产生未捕获 Promise 拒绝。

import type { ThemeMode } from '@/services/theme-mode';
import { applyThemeMode } from '@/services/theme-persistence';
import { runThemeViewTransition } from '@/services/view-transition';

export function applyThemeModeAnimated(mode: ThemeMode): void {
  runThemeViewTransition(() => {
    applyThemeMode(mode);
  });
}
