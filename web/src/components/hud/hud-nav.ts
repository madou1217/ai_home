// 侧栏导航的 HUD 编号与英文代号，按 config/routes.ts 的真实路由映射。
// 只做展示：不改路由 name（页面标题 / 面包屑仍用中文名）。

export interface HudNavCode {
  no?: string;
  code: string;
}

const NAV_CODES: Record<string, HudNavCode> = {
  '/dashboard': { no: '01', code: 'DASHBOARD' },
  '/accounts': { no: '02', code: 'ACCOUNTS' },
  '/chat': { no: '03', code: 'SESSIONS' },
  '/usage': { no: '04', code: 'USAGE' },
  '/models': { no: '05', code: 'MODELS' },
  '/scheduled-tasks': { no: '06', code: 'SCHEDULE' },
  '/toolkit': { no: '07', code: 'TOOLKIT' },
  '/studio': { no: '08', code: 'STUDIO' },
  '/studio/image': { code: 'IMAGE' },
  '/studio/translation': { code: 'TRANSLATE' },
  '/fabric': { no: '09', code: 'SERVER' },
  '/fabric/servers': { code: 'NODES' },
  '/fabric/ssh-hosts': { code: 'SSH' },
  '/settings': { no: '10', code: 'CONFIG' },
};

export function resolveHudNavCode(path: string | undefined): HudNavCode | null {
  if (!path) return null;
  return NAV_CODES[path] || null;
}
