import { useLocation } from '@umijs/max';
import { Suspense, useEffect } from 'react';
import type { ReactNode } from 'react';
import MobileBoot from './MobileBoot';
import { resolveMobileRoute } from './mobile-routes';
import { MOBILE_PAGES } from './pages';
import MobileHudShell from './shell/MobileHudShell';
import { useMobileMode } from './use-mobile-mode';
import './styles/mobile-hud.css';

interface Props {
  /** 桌面端（或未登记路由）渲染的原页面；已经过 workspace gate */
  children: ReactNode;
  /** 与桌面同一判定：Server 配置完整、允许渲染工作区 */
  workspaceEnabled: boolean;
  /** Server 就绪：顶栏遥测、底部导航可用 */
  dataPlaneReady: boolean;
}

/**
 * 移动端入口：视口 < 768px 时，按路由渲染独立的移动端 HUD 页面（web/src/mobile/pages），
 * 桌面页面不会被挂载；桌面端原样返回 children。
 */
export default function MobileApp({ children, workspaceEnabled, dataPlaneReady }: Props) {
  const mobile = useMobileMode();
  const location = useLocation();

  useEffect(() => {
    const root = document.documentElement;
    if (mobile) root.setAttribute('data-mobile-hud', '');
    else root.removeAttribute('data-mobile-hud');
    return () => root.removeAttribute('data-mobile-hud');
  }, [mobile]);

  if (!mobile) return <>{children}</>;
  if (!workspaceEnabled) return null;

  const resolved = resolveMobileRoute(location.pathname || '');
  const Page = resolved ? MOBILE_PAGES[resolved.entry.pattern] : undefined;
  const isSetup = resolved?.entry.pattern === '/server-setup';

  return (
    <MobileHudShell
      entry={resolved?.entry ?? null}
      telemetryEnabled={dataPlaneReady && !isSetup}
      navEnabled={dataPlaneReady && !isSetup}
    >
      {Page && resolved ? (
        <Suspense fallback={<MobileBoot />}>
          <Page key={resolved.entry.pattern} params={resolved.params} />
        </Suspense>
      ) : (
        children
      )}
    </MobileHudShell>
  );
}
