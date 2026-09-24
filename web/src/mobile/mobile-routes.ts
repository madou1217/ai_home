import type { ComponentType, LazyExoticComponent } from 'react';

/** 移动端页面统一签名：只拿路由参数，数据全部经真实 API / hooks 自取。 */
export interface MobilePageProps {
  params: Record<string, string | undefined>;
}

export type MobilePageComponent = LazyExoticComponent<ComponentType<MobilePageProps>> | ComponentType<MobilePageProps>;

export interface MobileRouteEntry {
  /** 与 config/routes.ts 同名的真实路由（不新增任何路由） */
  pattern: string;
  /** HUD 分区代号（顶栏展示） */
  code: string;
  /** 顶栏中文标题 */
  title: string;
  /** 底部导航归属：主 Tab 的 key，或 'more' 表示落在「更多」面板 */
  nav: MobileNavKey;
}

export type MobileNavKey = 'dashboard' | 'accounts' | 'chat' | 'usage' | 'more';

/**
 * 路由表：顺序即匹配优先级（更具体的路径在前）。
 * 只登记 config/routes.ts 中真实存在的页面；未登记的路径回落到原页面。
 */
export const MOBILE_ROUTES: MobileRouteEntry[] = [
  { pattern: '/dashboard', code: 'DASH', title: '仪表盘', nav: 'dashboard' },
  { pattern: '/accounts/:provider/:accountRef/models', code: 'MODELS', title: '账号模型', nav: 'accounts' },
  { pattern: '/accounts', code: 'ACCTS', title: '账号管理', nav: 'accounts' },
  { pattern: '/chat', code: 'CHAT', title: 'AI 会话', nav: 'chat' },
  { pattern: '/usage', code: 'USAGE', title: '模型用量', nav: 'usage' },
  { pattern: '/models', code: 'MODELS', title: '模型目录', nav: 'more' },
  { pattern: '/toolkit/install-guide', code: 'GUIDE', title: '安装指南', nav: 'more' },
  { pattern: '/toolkit', code: 'TOOLS', title: '开发工具', nav: 'more' },
  { pattern: '/studio/image', code: 'STUDIO', title: '灵感工坊', nav: 'more' },
  { pattern: '/fabric/servers', code: 'SERVER', title: 'Server 管理', nav: 'more' },
  { pattern: '/fabric/ssh-hosts', code: 'SSH', title: 'SSH 开发机', nav: 'more' },
  { pattern: '/settings', code: 'CONFIG', title: '设置', nav: 'more' },
  { pattern: '/server-setup', code: 'SETUP', title: '连接 Server', nav: 'more' },
];

export interface ResolvedMobileRoute {
  entry: MobileRouteEntry;
  params: Record<string, string | undefined>;
}

const splitPath = (path: string) => path.split('/').filter(Boolean);

/** 精确匹配（整段对齐）；`:name` 段捕获为参数，参数值做 URI 解码。 */
export function matchMobilePattern(pattern: string, pathname: string): Record<string, string> | null {
  const expected = splitPath(pattern);
  const actual = splitPath(pathname);
  if (expected.length !== actual.length) return null;
  const params: Record<string, string> = {};
  for (let index = 0; index < expected.length; index += 1) {
    const segment = expected[index];
    const value = actual[index];
    if (segment.startsWith(':')) {
      try {
        params[segment.slice(1)] = decodeURIComponent(value);
      } catch {
        params[segment.slice(1)] = value;
      }
    } else if (segment !== value) {
      return null;
    }
  }
  return params;
}

export function resolveMobileRoute(pathname: string): ResolvedMobileRoute | null {
  for (const entry of MOBILE_ROUTES) {
    const params = matchMobilePattern(entry.pattern, pathname);
    if (params) return { entry, params };
  }
  return null;
}
