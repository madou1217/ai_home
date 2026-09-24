import type { ReactNode } from 'react';
import type { MobileRouteEntry } from '../mobile-routes';
import MobileHudNav from './MobileHudNav';
import MobileHudTopBar from './MobileHudTopBar';

interface Props {
  entry: MobileRouteEntry | null;
  telemetryEnabled: boolean;
  /** 首次连接 Server 前（setup 闸门）不显示导航，只留顶栏与页面 */
  navEnabled: boolean;
  children: ReactNode;
}

/**
 * 独立的移动端 HUD 外壳：顶栏（安全区）→ 单列内容 → 拇指区底部导航（安全区）。
 * 沉浸态（会话对话视图设置 body[data-mobile-immersive]）由 CSS 隐藏顶栏与导航。
 */
export default function MobileHudShell({ entry, telemetryEnabled, navEnabled, children }: Props) {
  return (
    <div className={`mhud-shell${navEnabled ? ' has-nav' : ''}`}>
      <MobileHudTopBar entry={entry} telemetryEnabled={telemetryEnabled} />
      <main className="mhud-main" aria-label={entry?.title}>
        {children}
      </main>
      {navEnabled ? <MobileHudNav active={entry?.nav ?? null} /> : null}
    </div>
  );
}
