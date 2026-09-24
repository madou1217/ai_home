import { lazy } from 'react';
import type { MobilePageComponent } from '../mobile-routes';

/**
 * 移动端页面表（键 = MOBILE_ROUTES.pattern）。每页独立分包，按需加载。
 * 页面只复用数据层（services/api、features/* hooks、业务弹窗），不复用桌面布局。
 */
export const MOBILE_PAGES: Record<string, MobilePageComponent> = {
  '/dashboard': lazy(() => import('./MobileDashboard')),
  '/accounts/:provider/:accountRef/models': lazy(() => import('./MobileAccountModels')),
  '/accounts': lazy(() => import('./MobileAccounts')),
  '/chat': lazy(() => import('./MobileChat')),
  '/usage': lazy(() => import('./MobileUsage')),
  '/models': lazy(() => import('./MobileModels')),
  '/toolkit/install-guide': lazy(() => import('./MobileInstallGuide')),
  '/toolkit': lazy(() => import('./MobileToolkit')),
  '/studio/image': lazy(() => import('./MobileStudio')),
  '/fabric/servers': lazy(() => import('./MobileServers')),
  '/fabric/ssh-hosts': lazy(() => import('./MobileSshHosts')),
  '/settings': lazy(() => import('./MobileSettings')),
  '/server-setup': lazy(() => import('./MobileServerSetup')),
};
