import type { MobileNavKey } from '../mobile-routes';

export interface MobileNavTab {
  key: Exclude<MobileNavKey, 'more'>;
  path: string;
  code: string;
  label: string;
}

/** 底部主导航：高频页面（均为 config/routes.ts 的真实路由）。 */
export const MOBILE_NAV_TABS: MobileNavTab[] = [
  { key: 'dashboard', path: '/dashboard', code: '01', label: '仪表盘' },
  { key: 'accounts', path: '/accounts', code: '02', label: '账号' },
  { key: 'chat', path: '/chat', code: '03', label: '会话' },
  { key: 'usage', path: '/usage', code: '04', label: '用量' },
];

export interface MobileMoreItem {
  path: string;
  code: string;
  label: string;
  desc: string;
}

/** 「更多」面板：低频页面入口（与 MOBILE_ROUTES 中 nav:'more' 的页面一一对应）。 */
export const MOBILE_MORE_ITEMS: MobileMoreItem[] = [
  { path: '/models', code: '05', label: '模型目录', desc: 'MODELS' },
  { path: '/toolkit', code: '06', label: '开发工具', desc: 'TOOLKIT' },
  { path: '/studio/image', code: '07', label: '灵感工坊', desc: 'STUDIO' },
  { path: '/fabric/servers', code: '08', label: 'Server 管理', desc: 'SERVER' },
  { path: '/fabric/ssh-hosts', code: '08', label: 'SSH 开发机', desc: 'SSH' },
  { path: '/settings', code: '09', label: '设置', desc: 'CONFIG' },
];
