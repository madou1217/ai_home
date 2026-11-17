// 侧栏导航的 HUD 编号与英文代号，严格按 config/routes.ts 的真实可见菜单顺序映射。
// 纯零依赖元数据模块：不改路由 name（页面标题 / 面包屑仍用中文名），不引入运行时服务副作用；
// 隐藏路由（/chat/quick、/toolkit/install-guide、/server-setup、账号子路由与重定向）不占用一级序号。

export interface HudNavCode {
  /** 可见菜单序号：一级菜单为 01..13，二级子菜单采用稳定父子层级（如 10.01 / 10.02） */
  no: string;
  /** 右侧 HUD 英文代号 */
  code: string;
  /** 二级菜单所属父路径（用于层级标记与对齐） */
  parentPath?: string;
  /** 单调递增的导航拓扑序，供路由与面板切换判定前后方向 */
  order: number;
}

const NAV_CODES: Record<string, HudNavCode> = {
  '/dashboard': { no: '01', code: 'DASHBOARD', order: 1 },
  '/accounts': { no: '02', code: 'ACCOUNTS', order: 2 },
  '/chat': { no: '03', code: 'SESSIONS', order: 3 },
  '/terminals': { no: '04', code: 'TERMINALS', order: 4 },
  '/usage': { no: '05', code: 'USAGE', order: 5 },
  '/models': { no: '06', code: 'MODELS', order: 6 },
  '/scheduled-tasks': { no: '07', code: 'SCHEDULE', order: 7 },
  '/peer-inbox': { no: '08', code: 'INBOX', order: 8 },
  '/toolkit': { no: '09', code: 'TOOLKIT', order: 9 },
  '/studio': { no: '10', code: 'STUDIO', order: 10 },
  '/studio/image': { no: '10.01', code: 'IMAGE', parentPath: '/studio', order: 10.01 },
  '/studio/translation': { no: '10.02', code: 'TRANSLATE', parentPath: '/studio', order: 10.02 },
  '/servers': { no: '11', code: 'SERVER', order: 11 },
  '/ssh-hosts': { no: '12', code: 'SSH', order: 12 },
  '/settings': { no: '13', code: 'CONFIG', order: 13 },
};

function normalizeNavPath(path: string | undefined): string {
  if (!path) return '';
  const withoutQuery = path.split(/[?#]/, 1)[0].trim();
  if (!withoutQuery) return '';
  let normalized = withoutQuery.startsWith('/') ? withoutQuery : `/${withoutQuery}`;
  normalized = normalized.replace(/\/{2,}/g, '/');
  if (normalized === '/ui') {
    normalized = '/';
  } else if (normalized.startsWith('/ui/')) {
    normalized = normalized.slice(3);
  }
  if (normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

export function resolveHudNavCode(path: string | undefined): HudNavCode | null {
  const normalized = normalizeNavPath(path);
  if (!normalized) return null;
  return NAV_CODES[normalized] || null;
}

/**
 * 解析任意应用路由对应的导航拓扑序（含不占菜单序号的二级详情页与重定向），
 * 用于主工作区切页时判定前进 / 后退过渡方向；独立无壳窗口（如 /chat/quick）返回 null。
 */
export function resolveHudRouteOrder(pathname: string | undefined): number | null {
  const normalized = normalizeNavPath(pathname);
  if (!normalized || normalized === '/chat/quick') return null;
  if (normalized === '/') return NAV_CODES['/dashboard'].order;
  if (normalized === '/studio') return NAV_CODES['/studio/image'].order;
  if (normalized === '/translation') return NAV_CODES['/studio/translation'].order;

  const direct = NAV_CODES[normalized];
  if (direct) return direct.order;

  if (/^\/accounts\/[^/]+\/[^/]+\/models$/.test(normalized)) return 2.01;
  if (/^\/accounts\/[^/]+\/[^/]+\/quota$/.test(normalized)) return 2.02;
  if (normalized === '/toolkit/install-guide') return 9.01;
  if (normalized === '/server-setup') return 11.01;
  return null;
}
