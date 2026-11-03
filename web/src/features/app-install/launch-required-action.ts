/**
 * 应用启动失败时，服务端由各 provider 的桌面启动策略声明“下一步该做什么”
 * （如 Kimi Desktop 的托管扫码登录）。WebUI 只读这份声明，不再按 provider 名分支。
 */
export interface DesktopLoginRequiredAction {
  kind: 'desktop-login';
  /** 托管登录流程标识，由服务端策略给出 */
  flow: string;
  /** 服务端 message 需要作为警告展示（如登录态写入失败） */
  warn: boolean;
  message: string;
}

// WebUI 已实现的托管登录流程；未知流程按普通错误处理。
const SUPPORTED_DESKTOP_LOGIN_FLOWS = new Set(['kimi-desktop-session']);

function responseData(error: unknown): Record<string, unknown> | null {
  if (!error || typeof error !== 'object') return null;
  const data = (error as { response?: { data?: unknown } }).response?.data;
  return data && typeof data === 'object' ? (data as Record<string, unknown>) : null;
}

export function desktopLoginRequiredAction(error: unknown): DesktopLoginRequiredAction | null {
  const data = responseData(error);
  const action = data?.requiredAction as { kind?: unknown; flow?: unknown; warn?: unknown } | undefined;
  if (!action || action.kind !== 'desktop-login') return null;
  const flow = String(action.flow || '');
  if (!SUPPORTED_DESKTOP_LOGIN_FLOWS.has(flow)) return null;
  return {
    kind: 'desktop-login',
    flow,
    warn: action.warn === true,
    message: typeof data?.message === 'string' ? data.message : ''
  };
}
