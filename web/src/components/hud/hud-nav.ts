// 侧栏导航的 HUD 编号与英文代号，严格按 config/routes.ts 的真实可见菜单顺序映射。
// 纯零依赖元数据模块：不改路由 name（页面标题 / 面包屑仍用中文名），不引入运行时服务副作用；
// 隐藏路由（/chat/quick、/toolkit/install-guide、/server-setup、账号子路由与重定向）不占用一级序号。

export interface HudNavCode {
  /** 可见菜单序号：一级菜单为 01..12，二级子菜单采用稳定父子层级（如 09.01 / 09.02） */
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
  // AI 会话拆成 Chat / Work 子菜单：一级编号 03 给父菜单，子项用层级编号 03.01 / 03.02。
  '/chat': { no: '03.01', code: 'CHAT', parentPath: '/chat', order: 3.01 },
  // Work 是独立顶级路径（/work），编号仍归属「03 AI 会话」，所以 parentPath 保持 /chat：
  // 层级标记看的是业务分组，不是 URL 前缀。
  '/work': { no: '03.02', code: 'WORK', parentPath: '/chat', order: 3.02 },
  // 历史链接（/chat/work 会跳到 /work）：保留同一编号，避免跳转瞬间序号闪成一级。
  '/chat/work': { no: '03.02', code: 'WORK', parentPath: '/chat', order: 3.02 },
  '/projects': { no: '04', code: 'PROJECT', order: 4 },
  '/projects/office': { no: '04.01', code: 'OFFICE', parentPath: '/projects', order: 4.01 },
  '/projects/requirements': { no: '04.02', code: 'REQUIRE', parentPath: '/projects', order: 4.02 },
  // 历史深链：项目办公室迁移后仍映射到 04.01，避免旧链接失去序号/顺序。
  '/terminals': { no: '04.01', code: 'OFFICE', parentPath: '/projects', order: 4.01 },
  '/usage': { no: '05', code: 'USAGE', order: 5 },
  '/models': { no: '06', code: 'MODELS', order: 6 },
  '/scheduled-tasks': { no: '07', code: 'SCHEDULE', order: 7 },
  '/toolkit': { no: '08', code: 'TOOLKIT', order: 8 },
  '/clipboard': { no: '09', code: 'CLIPBOARD', order: 9 },
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

// 父菜单若没有自己的路径（如 AI 会话），从子项路径反查一级编号，避免子项顶掉 03 后
// 一级序号出现空洞，也让菜单编号与 04.01 / 10.02 的既有层级约定保持一致。
// 取首个子项（/chat）即可代表整组：Work 已拆到 /work，但业务分组仍是 03 AI 会话。
const SUBMENU_PARENT_CODES: Record<string, HudNavCode> = {
  '/chat': { no: '03', code: 'SESSIONS', order: 3 },
};

export function resolveHudNavCode(path: string | undefined): HudNavCode | null {
  const normalized = normalizeNavPath(path);
  if (!normalized) return null;
  return NAV_CODES[normalized] || null;
}

export function resolveHudSubmenuParentCode(children: unknown[] | undefined): HudNavCode | null {
  if (!Array.isArray(children)) return null;
  for (const child of children) {
    if (!child || typeof child !== 'object') continue;
    const path = (child as { path?: unknown }).path;
    const code = SUBMENU_PARENT_CODES[normalizeNavPath(typeof path === 'string' ? path : undefined)];
    if (code) return code;
  }
  return null;
}

/**
 * 解析任意应用路由对应的导航拓扑序（含不占菜单序号的二级详情页与重定向），
 * 用于主工作区切页时判定前进 / 后退过渡方向；独立无壳窗口（如 /chat/quick）返回 null。
 */
export function resolveHudRouteOrder(pathname: string | undefined): number | null {
  const normalized = normalizeNavPath(pathname);
  if (!normalized || normalized === '/chat/quick') return null;
  if (normalized === '/') return NAV_CODES['/dashboard'].order;
  if (normalized === '/peer-inbox') return NAV_CODES['/terminals'].order;
  if (normalized === '/studio') return NAV_CODES['/studio/image'].order;
  if (normalized === '/translation') return NAV_CODES['/studio/translation'].order;

  const direct = NAV_CODES[normalized];
  if (direct) return direct.order;

  if (/^\/accounts\/[^/]+\/[^/]+\/models$/.test(normalized)) return 2.01;
  if (/^\/accounts\/[^/]+\/[^/]+\/quota$/.test(normalized)) return 2.02;
  if (normalized === '/toolkit/install-guide') return 8.01;
  if (normalized === '/server-setup') return 11.01;
  return null;
}
