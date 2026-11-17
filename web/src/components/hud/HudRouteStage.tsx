import type { ReactNode } from 'react';

/**
 * 桌面端工作区主路由承载层（单树）：
 * 仅在路由 PUSH / POP 激活 ViewTransition 期间由 view-transition.ts 动态挂载唯一
 * `view-transition-name: aih-route-stage`，停靠态零 stacking context、绝不双挂载旧业务组件树。
 */
export default function HudRouteStage({ children }: { children: ReactNode }) {
  return <div className="aih-route-stage">{children}</div>;
}
