import api from '@/services/api';

/** 本机代理入口会话状态；URL 含租约凭据，只在管理面展示。 */
export interface ProxyServeSession {
  running: boolean;
  pid?: number;
  selector?: string;
  name?: string;
  httpUrl?: string;
  socks5Url?: string;
  startedAt?: number;
  error?: string;
  /** server = 本机管理面；ssh-peer = 经已保存 SSH 连接借用远端 AIH 入口。 */
  transport?: 'server' | 'ssh-peer';
  peer?: string;
  via?: string;
}

/** GET /webui/proxy-serve 的视图。 */
export interface ProxyServeView {
  ok: boolean;
  session: ProxyServeSession;
  cliAvailable: boolean;
  cliReason?: string;
}

export interface ProxyServeStartInput {
  selector: string;
  noSocks?: boolean;
  /** 非空时用该 SSH 连接借用远端 AIH 的入口；远端管理密钥不出对端。 */
  peer?: string;
  peerVia?: string;
  peerAih?: string;
}

export interface ProxyServeSSHConnection {
  id: string;
  label: string;
  host: string;
  port: number;
  user: string;
}

/** 常驻服务视图；selector/noSocks 只来自本机安装记录，不回显 URL。 */
export interface ProxyServeService {
  installed: boolean;
  loaded: boolean;
  pid?: number;
  label?: string;
  file?: string;
  log?: string;
  selector?: string;
  noSocks?: boolean;
  error?: string;
}

const BASE = '/webui/proxy-serve';

export const proxyServeAPI = {
  async view(): Promise<ProxyServeView> {
    const response = await api.get<ProxyServeView>(BASE);
    return response.data;
  },
  async start(input: ProxyServeStartInput): Promise<ProxyServeView> {
    const response = await api.post<{
      ok: boolean;
      session: ProxyServeSession;
    }>(`${BASE}/start`, input);
    return {
      ok: response.data.ok,
      session: response.data.session,
      cliAvailable: true
    };
  },
  async stop(): Promise<ProxyServeView> {
    const response = await api.post<{
      ok: boolean;
      session: ProxyServeSession;
    }>(`${BASE}/stop`, {});
    return {
      ok: response.data.ok,
      session: response.data.session,
      cliAvailable: true
    };
  },
  async serviceStatus(): Promise<ProxyServeService> {
    const response = await api.get<{ ok: boolean; service: ProxyServeService }>(`${BASE}/service`);
    return response.data.service;
  },
  async installService(input: ProxyServeStartInput): Promise<ProxyServeService> {
    const response = await api.post<{
      ok: boolean;
      service: ProxyServeService;
    }>(`${BASE}/service/install`, input);
    return response.data.service;
  },
  async uninstallService(): Promise<ProxyServeService> {
    const response = await api.post<{
      ok: boolean;
      service: ProxyServeService;
    }>(`${BASE}/service/uninstall`, {});
    return response.data.service;
  },
  async listSSHConnections(): Promise<ProxyServeSSHConnection[]> {
    const response = await api.get<{
      ok: boolean;
      connections?: ProxyServeSSHConnection[];
    }>('/webui/ssh-connections');
    return Array.isArray(response.data.connections) ? response.data.connections : [];
  }
};

export function describeProxyServeError(error: unknown): string {
  const response = (error as { response?: { data?: { message?: string; error?: string } } })?.response;
  return response?.data?.message || response?.data?.error || (error instanceof Error ? error.message : '请求失败');
}
