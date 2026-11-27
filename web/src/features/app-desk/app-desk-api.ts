import api, { resolveActiveServer } from '@/services/api';

export type AppDeskInstanceStatus = 'starting' | 'running' | 'exited' | 'unknown' | (string & {});

/** 通过 `aih app` 或 WebUI 启动并由应用看台跟踪的本机应用实例。 */
export interface AppDeskInstance {
  id: string;
  appId: string;
  name: string;
  path: string;
  executable?: string;
  kind: string;
  profileDir?: string;
  proxied: boolean;
  proxyUrl?: string;
  proxyMode?: string;
  /** 代理出口国家/城市（能解析时才有）：proxyRegion 是可直接展示的中文标签。 */
  proxyCountry?: string;
  proxyCity?: string;
  proxyRegion?: string;
  /** 代理端口探活：ok / down；仅看台运行时字段，不落盘。 */
  proxyHealth?: 'ok' | 'down' | (string & {});
  proxyHealthDetail?: string;
  startedAtMs: number;
  pids?: number[];
  live: boolean;
  /** 单实例应用复用已有进程时为 true（非本次新拉起）。 */
  adopted?: boolean;
  status: AppDeskInstanceStatus;
  exitedAtMs?: number;
}

/** 本机代理入口实时状态（来自 proxycontrol.Status）。 */
export interface AppDeskProxyStatus {
  running: boolean;
  pid?: number;
  httpUrl?: string;
  socks5Url?: string;
  leaseName?: string;
  /** 出口国家/城市（由租约名解析，能解析时才有）。 */
  region?: string;
  leaseActive: boolean;
  hotSwap: boolean;
  hotSwapAvailable: boolean;
  lastRenewAtMs?: number;
  lastError?: string;
  reconnects?: number;
  updatedAtMs?: number;
}

/** GET /v1/management/webui/apps/desk 返回的看台快照。 */
export interface AppDeskView {
  instances: AppDeskInstance[];
  /** 已结束实例数；历史行按需从 /desk/history 拉取。 */
  historyCount: number;
  proxy: AppDeskProxyStatus;
  hotSwap: boolean;
  proxyError?: string;
}

/** 本机应用目录项（与 alt+space、aih app 同一目录）。 */
export interface LocalApp {
  id: string;
  name: string;
  subtitle?: string;
  path: string;
  kind: string;
  icon?: string;
  terminal?: boolean;
  /** chromium = 浏览器参数；environment = 环境变量（应用可能忽略）。 */
  proxyMode: 'chromium' | 'environment' | (string & {});
  proxyLabel: string;
}

export interface LocalAppLaunchInput {
  id?: string;
  query?: string;
  proxy: boolean;
  proxyUrl?: string;
  /** 节点/地区选择器；与 proxyUrl 互斥，由服务端按候选解析。 */
  proxySelector?: string;
}

export interface LocalAppLaunchResponse {
  app: LocalApp;
  proxyUrl: string;
  proxyMode?: string;
  proxyLabel: string;
}

export interface AppDeskKillResult {
  id: string;
  name: string;
  pids?: number[];
  killed: boolean;
  message?: string;
}

export interface AppDeskRenewResponse {
  ok: boolean;
  proxy: AppDeskProxyStatus;
}

export interface AppDeskKillResponse {
  ok: boolean;
  results: AppDeskKillResult[];
  desk?: AppDeskView;
}

export interface AppDeskHotSwapResponse {
  ok: boolean;
  hotSwap: boolean;
  proxy?: AppDeskProxyStatus;
  running?: boolean;
}

export interface AppDeskErrorInfo {
  code?: string;
  message: string;
  status?: number;
  proxy?: AppDeskProxyStatus;
}

const PUBLIC_BASE = '/webui/apps/desk';
const MANAGEMENT_BASE = '/v1/management/webui/apps/desk';
const PUBLIC_APPS_BASE = '/webui/apps';
const MANAGEMENT_APPS_BASE = '/v1/management/webui/apps';

const DEFAULT_PROXY_STATUS: AppDeskProxyStatus = {
  running: false,
  leaseActive: false,
  hotSwap: false,
  hotSwapAvailable: false
};

const ERROR_CODE_LABELS: Record<string, string> = {
  app_not_proxied: '选中的应用没有使用代理',
  proxy_not_running: '本机代理入口未运行',
  renew_failed: '代理租约续约失败',
  hot_swap_failed: '切换热替换失败',
  kill_failed: '结束应用进程失败',
  desk_failed: '读取应用看台失败',
  route_not_found: '当前服务端未启用应用看台接口（需要桌面会话）'
};

// 当前端直连本机 Server 且 /v0 别名未挂载（SkipPublicAlias）时，
// 自动切到 /v1/management 路径并缓存，避免每 1.5s 轮询产生重复 404。
let preferManagementPrefix = false;

function isHttpStatus(error: unknown, targetStatus: number): boolean {
  const status = (error as { response?: { status?: number } })?.response?.status;
  return status === targetStatus;
}

async function requestLocal<T>(
  method: 'GET' | 'POST',
  publicBase: string,
  managementBase: string,
  suffix: string,
  payload?: unknown
): Promise<T> {
  const remote = resolveActiveServer().isRemote;
  const invoke = async (useManagement: boolean): Promise<T> => {
    const url = `${useManagement ? managementBase : publicBase}${suffix}`;
    const config = useManagement ? { baseURL: '' } : undefined;
    if (method === 'GET') {
      const response = await api.get<T>(url, config);
      return response.data;
    }
    const response = await api.post<T>(url, payload ?? {}, config);
    return response.data;
  };

  if (remote) {
    return invoke(false);
  }
  if (preferManagementPrefix) {
    return invoke(true);
  }
  try {
    return await invoke(false);
  } catch (error: unknown) {
    if (!isHttpStatus(error, 404)) {
      throw error;
    }
    try {
      const data = await invoke(true);
      preferManagementPrefix = true;
      return data;
    } catch (fallbackError: unknown) {
      if (!isHttpStatus(fallbackError, 404)) {
        preferManagementPrefix = true;
      }
      throw fallbackError;
    }
  }
}

function requestDesk<T>(method: 'GET' | 'POST', suffix: string, payload?: unknown): Promise<T> {
  return requestLocal<T>(method, PUBLIC_BASE, MANAGEMENT_BASE, suffix, payload);
}

function requestApps<T>(method: 'GET' | 'POST', suffix: string, payload?: unknown): Promise<T> {
  return requestLocal<T>(method, PUBLIC_APPS_BASE, MANAGEMENT_APPS_BASE, suffix, payload);
}

function normalizeProxyStatus(raw?: Partial<AppDeskProxyStatus> | null): AppDeskProxyStatus {
  if (!raw || typeof raw !== 'object') {
    return { ...DEFAULT_PROXY_STATUS };
  }
  return {
    running: Boolean(raw.running),
    pid: typeof raw.pid === 'number' && raw.pid > 0 ? raw.pid : undefined,
    httpUrl: typeof raw.httpUrl === 'string' && raw.httpUrl ? raw.httpUrl : undefined,
    socks5Url: typeof raw.socks5Url === 'string' && raw.socks5Url ? raw.socks5Url : undefined,
    leaseName: typeof raw.leaseName === 'string' && raw.leaseName ? raw.leaseName : undefined,
    region: typeof raw.region === 'string' && raw.region ? raw.region : undefined,
    leaseActive: Boolean(raw.leaseActive),
    hotSwap: Boolean(raw.hotSwap),
    hotSwapAvailable: Boolean(raw.hotSwapAvailable),
    lastRenewAtMs: typeof raw.lastRenewAtMs === 'number' && raw.lastRenewAtMs > 0 ? raw.lastRenewAtMs : undefined,
    lastError: typeof raw.lastError === 'string' && raw.lastError ? raw.lastError : undefined,
    reconnects: typeof raw.reconnects === 'number' && raw.reconnects >= 0 ? raw.reconnects : 0,
    updatedAtMs: typeof raw.updatedAtMs === 'number' && raw.updatedAtMs > 0 ? raw.updatedAtMs : undefined
  };
}

function normalizeDeskView(raw?: Partial<AppDeskView> | null): AppDeskView {
  const proxy = normalizeProxyStatus(raw?.proxy);
  return {
    instances: Array.isArray(raw?.instances) ? raw.instances : [],
    historyCount: typeof raw?.historyCount === 'number' && raw.historyCount > 0 ? raw.historyCount : 0,
    proxy,
    hotSwap: typeof raw?.hotSwap === 'boolean' ? raw.hotSwap : proxy.hotSwap,
    proxyError: typeof raw?.proxyError === 'string' && raw.proxyError ? raw.proxyError : undefined
  };
}

export function extractAppDeskError(error: unknown, fallback = '请求失败'): AppDeskErrorInfo {
  const response = (error as {
    response?: {
      status?: number;
      data?: {
        error?: string;
        message?: string;
        proxy?: Partial<AppDeskProxyStatus>;
      };
    };
  })?.response;
  const code = typeof response?.data?.error === 'string' ? response.data.error.trim() : undefined;
  const rawMessage = typeof response?.data?.message === 'string' ? response.data.message.trim() : '';
  const mappedCode = code ? ERROR_CODE_LABELS[code] : undefined;
  const fallbackMessage = error instanceof Error && error.message ? error.message : fallback;
  const message = rawMessage || mappedCode || code || fallbackMessage;
  const proxy = response?.data?.proxy ? normalizeProxyStatus(response.data.proxy) : undefined;
  return {
    code,
    message,
    status: response?.status,
    proxy
  };
}

export function describeAppDeskError(error: unknown, fallback = '请求失败'): string {
  return extractAppDeskError(error, fallback).message;
}

/** 从代理 URL 中提取端口；不含凭据。 */
export function extractProxyPort(rawUrl?: string): string {
  const trimmed = (rawUrl || '').trim();
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    if (parsed.port) return parsed.port;
  } catch {
    const match = trimmed.match(/:(\d+)(?:\/|$)/);
    if (match) return match[1];
  }
  return '';
}

/** 去除代理 URL 中的用户名/密码凭据，避免在普通界面展示租约密钥。 */
export function sanitizeProxyUrl(rawUrl?: string): string {
  const trimmed = (rawUrl || '').trim();
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    parsed.username = '';
    parsed.password = '';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return trimmed;
  }
}

export const appDeskAPI = {
  async getDesk(): Promise<AppDeskView> {
    const data = await requestDesk<{ ok: boolean; desk?: Partial<AppDeskView> }>('GET', '');
    return normalizeDeskView(data.desk);
  },

  async renew(ids?: string[]): Promise<AppDeskRenewResponse> {
    const cleaned = Array.isArray(ids)
      ? ids.map((id) => id.trim()).filter(Boolean)
      : [];
    const payload = cleaned.length > 0 ? { ids: cleaned } : {};
    const data = await requestDesk<{ ok: boolean; proxy?: Partial<AppDeskProxyStatus> }>(
      'POST',
      '/renew',
      payload
    );
    return {
      ok: Boolean(data.ok),
      proxy: normalizeProxyStatus(data.proxy)
    };
  },

  async kill(ids: string[]): Promise<AppDeskKillResponse> {
    const cleaned = ids.map((id) => id.trim()).filter(Boolean);
    const data = await requestDesk<{
      ok: boolean;
      results?: AppDeskKillResult[];
      desk?: Partial<AppDeskView>;
    }>('POST', '/kill', { ids: cleaned });
    return {
      ok: Boolean(data.ok),
      results: Array.isArray(data.results) ? data.results : [],
      desk: data.desk ? normalizeDeskView(data.desk) : undefined
    };
  },

  async setHotSwap(enabled: boolean): Promise<AppDeskHotSwapResponse> {
    const data = await requestDesk<{
      ok: boolean;
      hotSwap?: boolean;
      proxy?: Partial<AppDeskProxyStatus>;
      running?: boolean;
    }>('POST', '/hot-swap', { enabled });
    return {
      ok: Boolean(data.ok),
      hotSwap: typeof data.hotSwap === 'boolean' ? data.hotSwap : enabled,
      proxy: data.proxy ? normalizeProxyStatus(data.proxy) : undefined,
      running: data.running
    };
  },

  /** 历史：已结束的启动记录（主列表不再混入）。 */
  async history(): Promise<AppDeskInstance[]> {
    const data = await requestDesk<{ ok: boolean; instances?: AppDeskInstance[] }>('GET', '/history');
    return Array.isArray(data.instances) ? data.instances : [];
  },

  /** 清理历史；ids 为空时清空全部已结束记录。 */
  async clearHistory(ids?: string[]): Promise<number> {
    const cleaned = Array.isArray(ids) ? ids.map((id) => id.trim()).filter(Boolean) : [];
    const data = await requestDesk<{ ok: boolean; removed?: number }>(
      'POST',
      '/history/clear',
      cleaned.length > 0 ? { ids: cleaned } : {}
    );
    return typeof data.removed === 'number' ? data.removed : 0;
  },

  /** 本机应用目录（与 alt+space / aih app 同源）。 */
  async listApps(): Promise<LocalApp[]> {
    const data = await requestApps<{ ok: boolean; apps?: LocalApp[] }>('GET', '');
    return Array.isArray(data.apps) ? data.apps : [];
  },

  /** 启动一个独立应用实例；proxy=false 即直连。 */
  async launchApp(input: LocalAppLaunchInput): Promise<LocalAppLaunchResponse> {
    const data = await requestApps<{
      ok: boolean;
      app: LocalApp;
      proxyUrl?: string;
      proxyMode?: string;
      proxyLabel?: string;
    }>('POST', '/launch', input);
    return {
      app: data.app,
      proxyUrl: typeof data.proxyUrl === 'string' ? data.proxyUrl : '',
      proxyMode: data.proxyMode,
      proxyLabel: data.proxyLabel || data.app?.proxyLabel || ''
    };
  }
};
