import axios, { AxiosError } from 'axios';
import type {
  Account,
  AccountRefreshJob,
  AccountRefreshUsageResponse,
  AccountRemovedEvent,
  AccountsSnapshotRequestResponse,
  AccountsListResponse,
  AddAccountRequest,
  AddAccountResponse,
  AccountImportResponse,
  AccountImportJob,
  AccountAddJob,
  UsageConfig,
  ServerConfig,
  ControlPlaneDevice,
  ControlPlaneDeviceInvite,
  ControlPlaneDeviceInviteCreatePayload,
  ControlPlaneDeviceInviteCreateResponse,
  ControlPlaneEndpointHintsResponse,
  RemoteNode,
  RemoteNodeBootstrapApplyPayload,
  RemoteNodeBootstrapApplyResponse,
  RemoteNodeDefaults,
  RemoteNodeInvite,
  RemoteNodeBootstrapPlanResponse,
  RemoteNodeBootstrapProbeResponse,
  RemoteNodeInviteCreatePayload,
  RemoteNodeInviteCreateResponse,
  RemoteNodeManagementResponse,
  RemoteNodeSavePayload,
  RemoteNodeTestResponse,
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ChatStreamEvent,
  NativeSlashCommand,
  SlashCommandsResponse,
  ManagementStatus,
  ManagementMetrics,
  ManagementAccount,
  ManagementAccountsResponse,
  ManagementRestartEvent,
  ManagementRestartResponse,
  ModelUsageModelsResponse,
  ModelUsageQuery,
  ModelUsageScanJob,
  ModelUsageScanResponse,
  ModelUsageSessionDetailResponse,
  ModelUsageSessionsResponse,
  ModelUsageStatsResponse,
  WebUiOpenAIModelsResponse,
  WebUiOpenAIModelsJob,
  WebUiOpenAIModelsRefreshResponse,
  WebUiModelsResponse,
  AggregatedProject,
  ArchivedSession,
  SessionMessageBundle,
  SessionEventsResponse,
  SessionEventItem,
  SshHostTestResult
} from '@/types';

const api = axios.create({
  baseURL: '/v0',
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json'
  }
});

const SESSION_REQUEST_SCOPE = 'session-message-stream';
const sessionAbortControllers = new Map<string, AbortController>();
const inflightSessionRequests = new Map<string, Promise<any>>();

function normalizeRequestUrl(config: { baseURL?: string; url?: string }) {
  const baseUrl = String(config.baseURL || '').replace(/\/+$/, '');
  const url = String(config.url || '');
  if (!url) return '';
  if (/^https?:\/\//i.test(url)) return url;
  return `${baseUrl}${url.startsWith('/') ? url : `/${url}`}`;
}

function buildSessionRequestKey(url: string) {
  try {
    const parsed = new URL(url, 'http://local.ai-home');
    const pathname = parsed.pathname || '';
    if (!/^\/v0\/webui\/sessions\/[^/]+\/[^/]+\/(messages|events)$/.test(pathname)) {
      return '';
    }
    const [provider, sessionId, kind] = pathname.split('/').slice(-3);
    const projectDirName = parsed.searchParams.get('projectDirName') || '';
    const cursor = kind === 'events' ? (parsed.searchParams.get('cursor') || '0') : '';
    return `${SESSION_REQUEST_SCOPE}:${provider}:${sessionId}:${projectDirName}:${kind}:${cursor}`;
  } catch (_error) {
    return '';
  }
}

function buildSessionSupersedeKey(url: string) {
  try {
    const parsed = new URL(url, 'http://local.ai-home');
    const pathname = parsed.pathname || '';
    if (!/^\/v0\/webui\/sessions\/[^/]+\/[^/]+\/(messages|events)$/.test(pathname)) {
      return '';
    }
    const [provider, sessionId, kind] = pathname.split('/').slice(-3);
    const projectDirName = parsed.searchParams.get('projectDirName') || '';
    return `${SESSION_REQUEST_SCOPE}:${provider}:${sessionId}:${projectDirName}:${kind}`;
  } catch (_error) {
    return '';
  }
}

api.interceptors.request.use((config) => {
  const fullUrl = normalizeRequestUrl(config);
  const requestKey = buildSessionRequestKey(fullUrl);
  const supersedeKey = buildSessionSupersedeKey(fullUrl);
  if (!requestKey || !supersedeKey) {
    return config;
  }

  for (const [key, controller] of sessionAbortControllers.entries()) {
    if (key === requestKey) continue;
    if (!key.startsWith(`${supersedeKey}:`) && key !== supersedeKey) continue;
    controller.abort('session_request_superseded');
    sessionAbortControllers.delete(key);
  }

  const controller = new AbortController();
  sessionAbortControllers.set(requestKey, controller);
  config.signal = controller.signal;
  (config as any).__sessionRequestKey = requestKey;
  return config;
});

api.interceptors.response.use(
  (response) => {
    const requestKey = (response.config as any).__sessionRequestKey;
    if (requestKey) {
      sessionAbortControllers.delete(requestKey);
    }
    return response;
  },
  (error: AxiosError) => {
    const requestKey = (error.config as any)?.__sessionRequestKey;
    if (requestKey) {
      sessionAbortControllers.delete(requestKey);
    }
    return Promise.reject(error);
  }
);

function withSessionRequestDedup<T>(key: string, loader: () => Promise<T>): Promise<T> {
  if (!key) return loader();
  const inflight = inflightSessionRequests.get(key);
  if (inflight) {
    return inflight as Promise<T>;
  }
  const promise = loader().finally(() => {
    inflightSessionRequests.delete(key);
  });
  inflightSessionRequests.set(key, promise);
  return promise;
}

export function isSessionRequestCancelled(error: unknown) {
  if (axios.isCancel(error)) return true;
  const maybeError = error as { code?: string; message?: string };
  return maybeError?.code === 'ERR_CANCELED'
    || maybeError?.message === 'canceled'
    || maybeError?.message === 'session_request_superseded';
}

export type AccountExportFormat = 'sub2api' | 'antigravity' | 'cliproxyapi';
export interface AccountImportUploadFile {
  name: string;
  relativePath?: string;
  content?: string;
  contentBase64?: string;
  encoding?: 'text' | 'base64';
}

export type AccountImportPayload =
  | { content: string; provider?: string }
  | { mode: 'upload'; uploadKind?: 'file' | 'folder'; files: AccountImportUploadFile[]; provider?: string }
  | { mode: 'cliproxyapi'; provider?: string };

function buildWebSocketUrl(pathname: string): string {
  const base = typeof window === 'undefined'
    ? { protocol: 'http:', host: 'localhost' }
    : window.location;
  const protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${base.host}${pathname}`;
}

function dispatchAccountsWatchPayload(payload: any, handlers: {
  onSnapshot?: (payload: AccountsListResponse) => void;
  onSnapshotRequested?: (payload: { requestedAt?: number; hydrating?: boolean }) => void;
  onAccount?: (account: Account) => void;
  onAccountRemoved?: (payload: AccountRemovedEvent) => void;
  onHydrated?: (payload: { hydratedAt?: number }) => void;
  onImportJob?: (job: AccountImportJob) => void;
  onAuthJob?: (job: AccountAddJob) => void;
  onAccountRefreshJob?: (job: AccountRefreshJob) => void;
}) {
  if (payload.type === 'snapshot') {
    handlers.onSnapshot?.({
      accounts: Array.isArray(payload.accounts) ? payload.accounts : [],
      hydrating: Boolean(payload.hydrating),
      providerNativeCapabilities: payload.providerNativeCapabilities || {}
    });
    return;
  }
  if (payload.type === 'snapshot-requested') {
    handlers.onSnapshotRequested?.({
      requestedAt: Number(payload.requestedAt) || 0,
      hydrating: Boolean(payload.hydrating)
    });
    return;
  }
  if (payload.type === 'account' && payload.account) {
    handlers.onAccount?.(payload.account as Account);
    return;
  }
  if (payload.type === 'account-removed') {
    handlers.onAccountRemoved?.({
      provider: String(payload.provider || '') as AccountRemovedEvent['provider'],
      accountId: String(payload.accountId || ''),
      reason: String(payload.reason || ''),
      removedAt: Number(payload.removedAt) || 0
    });
    return;
  }
  if (payload.type === 'hydrated') {
    handlers.onHydrated?.({
      hydratedAt: Number(payload.hydratedAt) || 0
    });
    return;
  }
  if (payload.type === 'import-job' && payload.job) {
    handlers.onImportJob?.(payload.job as AccountImportJob);
    return;
  }
  if (payload.type === 'auth-job' && payload.job) {
    handlers.onAuthJob?.(payload.job as AccountAddJob);
    return;
  }
  if (payload.type === 'account-refresh-job' && payload.job) {
    handlers.onAccountRefreshJob?.(payload.job as AccountRefreshJob);
  }
}

// 账号管理 API
export const accountsAPI = {
  // 获取所有账号
  list: async (): Promise<AccountsListResponse> => {
    const response = await api.get<{ ok: boolean } & AccountsListResponse>('/webui/accounts');
    return {
      accounts: response.data.accounts,
      hydrating: Boolean(response.data.hydrating),
      providerNativeCapabilities: response.data.providerNativeCapabilities || {}
    };
  },

  watch: (handlers: {
    onSnapshot?: (payload: AccountsListResponse) => void;
    onSnapshotRequested?: (payload: { requestedAt?: number; hydrating?: boolean }) => void;
    onAccount?: (account: Account) => void;
    onAccountRemoved?: (payload: AccountRemovedEvent) => void;
    onHydrated?: (payload: { hydratedAt?: number }) => void;
    onImportJob?: (job: AccountImportJob) => void;
    onAuthJob?: (job: AccountAddJob) => void;
    onAccountRefreshJob?: (job: AccountRefreshJob) => void;
    onError?: () => void;
  }) => {
    let closed = false;
    let socket: WebSocket | null = null;
    let connectTimer: number | null = null;

    const scheduleConnect = (delayMs: number) => {
      if (closed || connectTimer !== null) return;
      connectTimer = window.setTimeout(() => {
        connectTimer = null;
        connect();
      }, delayMs);
    };

    const closeSocket = () => {
      const currentSocket = socket;
      socket = null;
      if (!currentSocket) return;
      currentSocket.onmessage = null;
      currentSocket.onerror = null;
      currentSocket.onclose = null;
      if (currentSocket.readyState === WebSocket.CONNECTING) {
        currentSocket.onopen = () => currentSocket.close();
        return;
      }
      if (currentSocket.readyState === WebSocket.OPEN) {
        currentSocket.close();
      }
    };

    const connect = () => {
      if (closed) return;
      socket = new WebSocket(buildWebSocketUrl('/v0/webui/accounts/watch'));
      socket.onmessage = (event) => {
        try {
          dispatchAccountsWatchPayload(JSON.parse(String(event.data || '{}')), handlers);
        } catch (_error) {
          // Ignore malformed WebSocket frames.
        }
      };
      socket.onerror = () => {
        handlers.onError?.();
      };
      socket.onclose = () => {
        if (closed) return;
        handlers.onError?.();
        scheduleConnect(1000);
      };
    };
    scheduleConnect(0);

    return {
      close: () => {
        closed = true;
        if (connectTimer !== null) {
          window.clearTimeout(connectTimer);
          connectTimer = null;
        }
        closeSocket();
      }
    };
  },

  // 添加新账号
  add: async (payload: AddAccountRequest): Promise<AddAccountResponse> => {
    const response = await api.post<AddAccountResponse>('/webui/accounts/add', payload);
    return response.data;
  },

  getAddJob: async (jobId: string): Promise<AccountAddJob> => {
    const response = await api.get<{ ok: boolean; job: AccountAddJob }>(`/webui/accounts/add/jobs/${jobId}`);
    return response.data.job;
  },

  cancelAddJob: async (jobId: string) => {
    const response = await api.post(`/webui/accounts/add/jobs/${jobId}/cancel`);
    return response.data;
  },

  completeBrowserCallback: async (jobId: string, callbackUrl: string): Promise<AccountAddJob> => {
    const response = await api.post<{ ok: boolean; job: AccountAddJob }>(
      `/webui/accounts/add/jobs/${jobId}/callback`,
      { callbackUrl }
    );
    return response.data.job;
  },

  reauth: async (provider: string, accountId: string): Promise<AddAccountResponse> => {
    const response = await api.post<AddAccountResponse>(`/webui/accounts/${provider}/${accountId}/reauth`);
    return response.data;
  },

  refreshUsage: async (provider: string, accountId: string): Promise<AccountRefreshUsageResponse> => {
    const response = await api.post<AccountRefreshUsageResponse>(`/webui/accounts/${provider}/${accountId}/refresh-usage`);
    return response.data;
  },

  requestSnapshot: async (): Promise<AccountsSnapshotRequestResponse> => {
    const response = await api.post<AccountsSnapshotRequestResponse>('/webui/accounts/watch/snapshot');
    return response.data;
  },

  updateStatus: async (provider: string, accountId: string, status: 'up' | 'down'): Promise<Account> => {
    const response = await api.post<{ ok: boolean; account: Account }>(`/webui/accounts/${provider}/${accountId}/status`, { status });
    return response.data.account;
  },

  updateAccount: async (provider: string, accountId: string, data: { apiKey?: string; baseUrl?: string; authMode?: string; credentialType?: string }): Promise<{ ok: boolean; account: Account }> => {
    const response = await api.post<{ ok: boolean; account: Account }>(`/webui/accounts/${provider}/${accountId}/update`, data);
    return response.data;
  },

  setDefault: async (provider: string, accountId: string): Promise<Account> => {
    const response = await api.post<{ ok: boolean; account: Account }>(`/webui/accounts/${provider}/${accountId}/set-default`);
    return response.data.account;
  },

  clearDefault: async (provider: string, accountId: string): Promise<Account> => {
    const response = await api.post<{ ok: boolean; account: Account }>(`/webui/accounts/${provider}/${accountId}/clear-default`);
    return response.data.account;
  },

  setMobile: async (provider: string, accountId: string): Promise<Account> => {
    const response = await api.post<{ ok: boolean; account: Account }>(`/webui/accounts/${provider}/${accountId}/set-mobile`);
    return response.data.account;
  },

  clearMobile: async (provider: string, accountId: string): Promise<Account> => {
    const response = await api.post<{ ok: boolean; account: Account }>(`/webui/accounts/${provider}/${accountId}/clear-mobile`);
    return response.data.account;
  },

  // 删除账号
  delete: async (provider: string, accountId: string) => {
    const response = await api.delete(`/webui/accounts/${provider}/${accountId}`);
    return response.data;
  },

  // 导出账号
  export: async (format: AccountExportFormat = 'sub2api') => {
    const response = await api.get('/webui/accounts/export', {
      params: { format },
      responseType: 'blob'
    });
    const contentType = (response.headers['content-type'] as string) || 'application/json';
    const url = URL.createObjectURL(new Blob([response.data], { type: contentType }));
    const a = document.createElement('a');
    a.href = url;
    a.download = response.headers['content-disposition']?.match(/filename="([^"]+)"/)?.[1] || 'sub2api-data.json';
    a.click();
    URL.revokeObjectURL(url);
    return undefined;
  },

  // 导入账号
  import: async (data: AccountImportPayload): Promise<AccountImportResponse> => {
    const response = await api.post<AccountImportResponse>('/webui/accounts/import', data);
    return response.data;
  },

  getImportJob: async (jobId: string): Promise<AccountImportJob> => {
    const response = await api.get<{ ok: boolean; job: AccountImportJob }>(`/webui/accounts/import/jobs/${jobId}`);
    return response.data.job;
  }
};

export interface ModelAlias {
  id: string;
  alias: string;
  target: string;
  provider: string;
  targetProvider: string;
  priority: number;
  enabled: boolean;
  description: string;
}

export const modelAliasesAPI = {
  getAll: async (): Promise<ModelAlias[]> => {
    const response = await api.get<{ ok: boolean; aliases: ModelAlias[] }>('/webui/model-aliases');
    return response.data.aliases || [];
  },
  create: async (alias: Partial<ModelAlias>): Promise<ModelAlias> => {
    const response = await api.post<{ ok: boolean; alias: ModelAlias }>('/webui/model-aliases', alias);
    return response.data.alias;
  },
  update: async (id: string, alias: Partial<ModelAlias>): Promise<ModelAlias> => {
    const response = await api.put<{ ok: boolean; alias: ModelAlias }>(`/webui/model-aliases/${id}`, alias);
    return response.data.alias;
  },
  delete: async (id: string): Promise<void> => {
    await api.delete(`/webui/model-aliases/${id}`);
  },
  toggle: async (id: string): Promise<ModelAlias> => {
    const response = await api.post<{ ok: boolean; alias: ModelAlias }>(`/webui/model-aliases/${id}/toggle`);
    return response.data.alias;
  }
};

// 本地文件系统 API
export const fsAPI = {
  read: async (path: string, projectPath?: string, source?: string): Promise<{ content: string; path: string; size: number; mtime: number }> => {
    // source 用于后端选择受控根目录，例如 Codex memory citation 不应按当前项目解析。
    const response = await api.get('/webui/fs/read', { params: { path, projectPath, source } });
    return response.data;
  }
};

// 配置管理 API
export const configAPI = {
  // 获取配置
  get: async (): Promise<UsageConfig> => {
    const response = await api.get<{ ok: boolean; config: UsageConfig }>('/webui/config');
    return response.data.config;
  },

  // 更新配置
  update: async (config: UsageConfig) => {
    const response = await api.post('/webui/config', { config });
    return response.data;
  },

  getServer: async (): Promise<ServerConfig> => {
    const response = await api.get<{ ok: boolean; config: ServerConfig }>('/webui/server-config');
    return response.data.config;
  },

  updateServer: async (config: ServerConfig) => {
    const response = await api.post('/webui/server-config', { config });
    return response.data;
  }
};

async function requestRemoteNodeManagement<TPayload = unknown>(
  nodeId: string,
  path: string,
  params?: Record<string, string | number | boolean | undefined>
): Promise<RemoteNodeManagementResponse<TPayload>> {
  const response = await api.get<RemoteNodeManagementResponse<TPayload>>(
    `/webui/nodes/${encodeURIComponent(nodeId)}/management/${path.replace(/^\/+/, '')}`,
    { params }
  );
  return response.data;
}

export const remoteNodesAPI = {
  getDefaults: async (): Promise<RemoteNodeDefaults> => {
    const response = await api.get<{ ok: boolean; defaults: RemoteNodeDefaults }>('/webui/nodes/defaults');
    return response.data.defaults;
  },

  list: async (): Promise<RemoteNode[]> => {
    const response = await api.get<{ ok: boolean; nodes: RemoteNode[] }>('/webui/nodes');
    return response.data.nodes || [];
  },

  save: async (payload: RemoteNodeSavePayload): Promise<RemoteNode> => {
    const response = await api.post<{ ok: boolean; node: RemoteNode }>('/webui/nodes', payload);
    return response.data.node;
  },

  listInvites: async (): Promise<RemoteNodeInvite[]> => {
    const response = await api.get<{ ok: boolean; invites: RemoteNodeInvite[] }>('/webui/nodes/invites');
    return response.data.invites || [];
  },

  createInvite: async (payload: RemoteNodeInviteCreatePayload): Promise<RemoteNodeInviteCreateResponse> => {
    const response = await api.post<RemoteNodeInviteCreateResponse>('/webui/nodes/invites', payload);
    return response.data;
  },

  getBootstrapPlan: async (payload: RemoteNodeInviteCreatePayload): Promise<RemoteNodeBootstrapPlanResponse> => {
    const response = await api.post<RemoteNodeBootstrapPlanResponse>('/webui/nodes/bootstrap-plan', payload);
    return response.data;
  },

  probeBootstrap: async (payload: RemoteNodeInviteCreatePayload): Promise<RemoteNodeBootstrapProbeResponse> => {
    const response = await api.post<RemoteNodeBootstrapProbeResponse>('/webui/nodes/bootstrap-probe', payload);
    return response.data;
  },

  applyBootstrap: async (payload: RemoteNodeBootstrapApplyPayload): Promise<RemoteNodeBootstrapApplyResponse> => {
    const response = await api.post<RemoteNodeBootstrapApplyResponse>('/webui/nodes/bootstrap-apply', payload);
    return response.data;
  },

  test: async (nodeId: string): Promise<RemoteNodeTestResponse> => {
    const response = await api.post<RemoteNodeTestResponse>(`/webui/nodes/${encodeURIComponent(nodeId)}/test`);
    return response.data;
  },

  management: async <TPayload = unknown>(
    nodeId: string,
    path: string,
    params?: Record<string, string | number | boolean | undefined>
  ): Promise<RemoteNodeManagementResponse<TPayload>> => {
    return requestRemoteNodeManagement<TPayload>(nodeId, path, params);
  },

  status: async (nodeId: string): Promise<RemoteNodeManagementResponse<ManagementStatus>> => {
    return requestRemoteNodeManagement<ManagementStatus>(nodeId, 'status');
  },

  metrics: async (nodeId: string): Promise<RemoteNodeManagementResponse<ManagementMetrics>> => {
    return requestRemoteNodeManagement<ManagementMetrics>(nodeId, 'metrics');
  },

  accounts: async (nodeId: string): Promise<RemoteNodeManagementResponse<ManagementAccountsResponse>> => {
    return requestRemoteNodeManagement<ManagementAccountsResponse>(nodeId, 'accounts');
  },

  usageStats: async (
    nodeId: string,
    query: Partial<ModelUsageQuery> = {}
  ): Promise<RemoteNodeManagementResponse<ModelUsageStatsResponse>> => {
    return requestRemoteNodeManagement<ModelUsageStatsResponse>(nodeId, 'usage/stats', query as Record<string, string | number | boolean | undefined>);
  }
};

export const controlPlaneDevicesAPI = {
  listEndpointHints: async (): Promise<ControlPlaneEndpointHintsResponse> => {
    const response = await api.get<ControlPlaneEndpointHintsResponse>('/webui/control-plane/endpoints');
    return {
      ok: response.data.ok,
      endpoints: response.data.endpoints || [],
      warnings: response.data.warnings || []
    };
  },

  listDevices: async (): Promise<ControlPlaneDevice[]> => {
    const response = await api.get<{ ok: boolean; devices: ControlPlaneDevice[] }>('/webui/control-plane/devices');
    return response.data.devices || [];
  },

  listInvites: async (): Promise<ControlPlaneDeviceInvite[]> => {
    const response = await api.get<{ ok: boolean; invites: ControlPlaneDeviceInvite[] }>('/webui/control-plane/devices/invites');
    return response.data.invites || [];
  },

  createInvite: async (payload: ControlPlaneDeviceInviteCreatePayload): Promise<ControlPlaneDeviceInviteCreateResponse> => {
    const response = await api.post<ControlPlaneDeviceInviteCreateResponse>('/webui/control-plane/devices/invites', payload);
    return response.data;
  },

  revokeDevice: async (deviceId: string): Promise<ControlPlaneDevice> => {
    const response = await api.post<{ ok: boolean; device: ControlPlaneDevice }>(
      `/webui/control-plane/devices/${encodeURIComponent(deviceId)}/revoke`
    );
    return response.data.device;
  }
};

// 会话管理 API
export const sessionsAPI = {
  // 获取所有聚合项目
  getAllProjects: async (): Promise<AggregatedProject[]> => {
    const response = await api.get<{ ok: boolean; projects: AggregatedProject[] }>('/webui/projects');
    return response.data.projects;
  },

  watchProjects: (handlers: {
    onSnapshot?: (payload: { revision: number; updatedAt: number; projects: AggregatedProject[] }) => void;
    onRuntime?: (runningSessionKeys: Set<string>) => void;
    onConnected?: () => void;
    onError?: () => void;
  }) => {
    const eventSource = new EventSource('/v0/webui/projects/watch');
    eventSource.onopen = () => {
      handlers.onConnected?.();
    };
    eventSource.onmessage = (event) => {
      try {
        const payload = JSON.parse(String(event.data || '{}'));
        if (payload.type === 'snapshot') {
          handlers.onSnapshot?.({
            revision: Number(payload.revision) || 0,
            updatedAt: Number(payload.updatedAt) || 0,
            projects: Array.isArray(payload.projects) ? payload.projects as AggregatedProject[] : []
          });
          return;
        }
        if (payload.type === 'runtime') {
          handlers.onRuntime?.(new Set(
            Array.isArray(payload.runningSessionKeys)
              ? payload.runningSessionKeys.map((item: unknown) => String(item || ''))
              : []
          ));
        }
      } catch (_error) {
        // Ignore malformed frames.
      }
    };
    eventSource.onerror = () => {
      handlers.onError?.();
    };
    return eventSource;
  },

  requestProjectsSnapshot: async () => {
    const response = await api.post('/webui/projects/watch/snapshot');
    return response.data;
  },

  // 归档会话
  archiveSession: async (provider: string, sessionId: string, projectDirName?: string) => {
    const response = await api.post('/webui/sessions/archive', {
      provider, sessionId, projectDirName
    });
    return response.data;
  },

  // 获取 session 的消息内容
  getSessionMessages: async (provider: string, sessionId: string, projectDirName?: string): Promise<ChatMessage[]> => {
    const bundle = await sessionsAPI.getSessionMessagesBundle(provider, sessionId, projectDirName);
    return bundle.messages;
  },

  getSessionMessagesBundle: async (provider: string, sessionId: string, projectDirName?: string): Promise<SessionMessageBundle> => {
    let url = `/webui/sessions/${provider}/${sessionId}/messages`;
    if (projectDirName) {
      url += `?projectDirName=${encodeURIComponent(projectDirName)}`;
    }
    return withSessionRequestDedup(
      buildSessionRequestKey(`/v0${url}`),
      async () => {
        const response = await api.get<{ ok: boolean; messages: ChatMessage[]; cursor?: number }>(url);
        return {
          messages: response.data.messages || [],
          cursor: Number(response.data.cursor) || 0
        };
      }
    );
  },

  getSessionEvents: async (
    provider: string,
    sessionId: string,
    cursor: number,
    projectDirName?: string
  ): Promise<{ events: SessionEventItem[]; cursor: number; requiresSnapshot?: boolean }> => {
    const params = new URLSearchParams();
    params.set('cursor', String(Math.max(0, Number(cursor) || 0)));
    if (projectDirName) {
      params.set('projectDirName', projectDirName);
    }
    const url = `/webui/sessions/${provider}/${sessionId}/events?${params.toString()}`;
    return withSessionRequestDedup(
      buildSessionRequestKey(`/v0${url}`),
      async () => {
        const response = await api.get<SessionEventsResponse>(url);
        return {
          events: response.data.events || [],
          cursor: Number(response.data.cursor) || 0,
          requiresSnapshot: Boolean(response.data.requiresSnapshot)
        };
      }
    );
  },

  // 获取所有已归档的会话
  getArchivedSessions: async (): Promise<ArchivedSession[]> => {
    const response = await api.get<{ ok: boolean; archived: ArchivedSession[] }>('/webui/sessions/archived');
    return response.data.archived;
  },

  // 还原归档会话
  unarchiveSession: async (provider: string, sessionId: string, projectDirName?: string) => {
    const response = await api.post('/webui/sessions/unarchive', {
      provider, sessionId, projectDirName
    });
    return response.data;
  },

  openProject: async (projectPath: string, name?: string) => {
    const response = await api.post<{ ok: boolean; project: AggregatedProject }>('/webui/projects/open', {
      projectPath,
      name
    });
    return response.data.project;
  },

  removeProject: async (projectPath: string) => {
    const response = await api.post('/webui/projects/remove', {
      projectPath
    });
    return response.data;
  },

  pickProjectDirectory: async (): Promise<{ cancelled: boolean; project?: { path: string; name: string } }> => {
    const response = await api.post<{ ok: boolean; cancelled: boolean; project?: { path: string; name: string } }>('/webui/projects/pick');
    return {
      cancelled: Boolean(response.data.cancelled),
      project: response.data.project
    };
  },

  browseProjectDirectory: async (subDir: string): Promise<any> => {
    const response = await api.post('/webui/projects/browse', { subDir });
    return response.data;
  }
};

type ModelCatalogRequestOptions = {
  accountRef?: string;
};

function appendModelCatalogParams(params: Record<string, string>, options: ModelCatalogRequestOptions) {
  if (options.accountRef) params.accountRef = String(options.accountRef);
}

// 模型列表 API：provider 分组用于选择器，账号级结果用于展示真实探测状态。
async function fetchWebUiModels(options: ModelCatalogRequestOptions = {}): Promise<WebUiModelsResponse> {
  const params: Record<string, string> = {};
  appendModelCatalogParams(params, options);
  const response = await api.get<WebUiModelsResponse>('/webui/models', {
    params: Object.keys(params).length > 0 ? params : undefined
  });
  return {
    ...response.data,
    models: response.data.models || {},
    byAccount: response.data.byAccount || {},
    byAccountRef: response.data.byAccountRef || {},
    selectableByAccountRef: response.data.selectableByAccountRef || {},
    defaultByAccountRef: response.data.defaultByAccountRef || {},
    errorsByAccount: response.data.errorsByAccount || {},
    errorsByAccountRef: response.data.errorsByAccountRef || {},
    labels: response.data.labels || {}
  };
}

export const modelsAPI = {
  listCatalog: fetchWebUiModels,
  listOpenAICompatible: async (options: ModelCatalogRequestOptions = {}): Promise<WebUiOpenAIModelsResponse> => {
    const params: Record<string, string> = {};
    appendModelCatalogParams(params, options);
    const response = await api.get<WebUiOpenAIModelsResponse>('/webui/openai-models', {
      params: Object.keys(params).length > 0 ? params : undefined
    });
    return {
      ...response.data,
      data: Array.isArray(response.data.data) ? response.data.data : [],
      managedData: Array.isArray(response.data.managedData) ? response.data.managedData : [],
      accounts: Array.isArray(response.data.accounts) ? response.data.accounts : [],
      byProvider: response.data.byProvider || {},
      byAccount: response.data.byAccount || {},
      byAccountRef: response.data.byAccountRef || {},
      errorsByAccount: response.data.errorsByAccount || {},
      errorsByAccountRef: response.data.errorsByAccountRef || {}
    };
  },
  createManualModel: async (payload: {
    id: string;
    provider: string;
    accountRef: string;
    description?: string;
    enabled?: boolean;
  }) => {
    const response = await api.post('/webui/openai-models', payload);
    return response.data;
  },
  updateModel: async (payload: {
    id: string;
    accountRef: string;
    enabled?: boolean;
    defaultModel?: boolean;
    provider?: string;
    description?: string;
  }) => {
    const response = await api.patch('/webui/openai-models', payload);
    return response.data;
  },
  deleteModel: async (payload: { id: string; accountRef: string; provider?: string }) => {
    const response = await api.post('/webui/openai-models/delete', payload);
    return response.data;
  },
  refreshOpenAICompatible: async (options: ModelCatalogRequestOptions = {}): Promise<WebUiOpenAIModelsRefreshResponse> => {
    const params: Record<string, string> = {};
    appendModelCatalogParams(params, options);
    const response = await api.post<WebUiOpenAIModelsRefreshResponse>('/webui/openai-models/refresh', null, {
      params: Object.keys(params).length > 0 ? params : undefined
    });
    return response.data;
  },
  watchOpenAICompatibleRefresh: (handlers: {
    onJob?: (job: WebUiOpenAIModelsJob) => void;
    onSnapshot?: (jobs: WebUiOpenAIModelsJob[]) => void;
    onError?: () => void;
  }) => {
    const eventSource = new EventSource('/v0/webui/openai-models/watch');
    eventSource.onmessage = (event) => {
      try {
        const payload = JSON.parse(String(event.data || '{}'));
        if (payload.type === 'model-catalog-job' && payload.job) {
          handlers.onJob?.(payload.job as WebUiOpenAIModelsJob);
        } else if (payload.type === 'model-catalog-snapshot') {
          handlers.onSnapshot?.(Array.isArray(payload.jobs) ? payload.jobs as WebUiOpenAIModelsJob[] : []);
        }
      } catch (_error) {
        // Ignore malformed frames.
      }
    };
    eventSource.onerror = () => {
      handlers.onError?.();
    };
    return eventSource;
  },
  listByProvider: async (): Promise<Record<string, string[]>> => {
    const response = await fetchWebUiModels();
    return response.models || {};
  }
};

// 聊天 API
export const chatAPI = {
  // 发送聊天消息
  send: async (request: ChatRequest): Promise<ChatResponse> => {
    const response = await api.post<ChatResponse>('/webui/chat', request);
    return response.data;
  },

  sendStream: async (
    request: ChatRequest,
    options: {
      signal?: AbortSignal;
      onEvent?: (event: ChatStreamEvent) => void;
    } = {}
  ): Promise<void> => {
    const response = await fetch('/v0/webui/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(request),
      signal: options.signal
    });

    if (!response.ok) {
      let errorMessage = `HTTP ${response.status}`;
      try {
        const data = await response.json();
        errorMessage = data?.message || data?.error || errorMessage;
      } catch (_error) {
        const text = await response.text().catch(() => '');
        if (text) errorMessage = text;
      }
      throw new Error(errorMessage);
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/event-stream')) {
      const data = await response.json();
      options.onEvent?.({
        type: 'done',
        content: data?.content || '',
        provider: data?.provider,
        accountId: data?.accountId,
        sessionId: data?.sessionId,
        mode: data?.mode
      });
      return;
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('stream_reader_unavailable');

    const decoder = new TextDecoder();
    let buffer = '';

    const emitEvent = (rawBlock: string) => {
      const dataLines = rawBlock
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim());
      if (dataLines.length === 0) return;
      const payload = dataLines.join('\n');
      if (!payload || payload === '[DONE]') return;
      const parsed = JSON.parse(payload) as ChatStreamEvent;
      options.onEvent?.(parsed);
      if (parsed.type === 'error') {
        throw new Error(parsed.message || parsed.code || 'chat_stream_failed');
      }
    };

    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });

      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary).trim();
        buffer = buffer.slice(boundary + 2);
        if (block) emitEvent(block);
        boundary = buffer.indexOf('\n\n');
      }

      if (done) break;
    }

    if (buffer.trim()) {
      emitEvent(buffer.trim());
    }
  },

  sendRunInput: async (runId: string, input: string, appendNewline = true, promptId = '') => {
    const response = await api.post(`/webui/chat/runs/${encodeURIComponent(runId)}/input`, {
      input,
      appendNewline,
      promptId
    });
    return response.data;
  },

  resizeRunTerminal: async (runId: string, cols: number, rows: number) => {
    const response = await api.post(`/webui/chat/runs/${encodeURIComponent(runId)}/resize`, {
      cols,
      rows
    });
    return response.data;
  },

  getSlashCommands: async (provider: string): Promise<NativeSlashCommand[]> => {
    const response = await api.get<SlashCommandsResponse>(`/webui/slash-commands?provider=${encodeURIComponent(provider)}`);
    return response.data.commands || [];
  }
};

// 管理 API
export const managementAPI = {
  // 获取服务器状态
  status: async (): Promise<ManagementStatus> => {
    const response = await api.get<ManagementStatus>('/webui/management/status');
    return response.data;
  },

  // 获取服务器指标
  metrics: async (): Promise<ManagementMetrics> => {
    const response = await api.get<ManagementMetrics>('/webui/management/metrics');
    return response.data;
  },

  accounts: async (): Promise<ManagementAccountsResponse> => {
    const response = await api.get<ManagementAccountsResponse>('/webui/management/accounts');
    return response.data;
  },

  watch: (handlers: {
    onSnapshot?: (payload: {
      status: ManagementStatus;
      metrics: ManagementMetrics;
      accounts: ManagementAccount[];
    }) => void;
    onRestart?: (payload: ManagementRestartEvent) => void;
    onConnected?: () => void;
    onError?: () => void;
  }) => {
    const eventSource = new EventSource('/v0/webui/management/watch');
    eventSource.onopen = () => {
      handlers.onConnected?.();
    };
    eventSource.onmessage = (event) => {
      try {
        const payload = JSON.parse(String(event.data || '{}'));
        if (payload.type === 'snapshot') {
          handlers.onSnapshot?.({
            status: payload.status as ManagementStatus,
            metrics: payload.metrics as ManagementMetrics,
            accounts: Array.isArray(payload.accounts) ? payload.accounts as ManagementAccount[] : []
          });
          return;
        }
        if (payload.type === 'restart') {
          handlers.onRestart?.(payload as ManagementRestartEvent);
        }
      } catch (_error) {
        // Ignore malformed frames.
      }
    };
    eventSource.onerror = () => {
      handlers.onError?.();
    };
    return eventSource;
  },

  requestSnapshot: async () => {
    const response = await api.post('/webui/management/watch/snapshot');
    return response.data;
  },

  // 重新加载账号
  reload: async () => {
    const response = await api.post('/webui/management/reload');
    return response.data;
  },

  // 清除冷却时间
  clearCooldown: async () => {
    const response = await api.post('/webui/management/cooldown/clear');
    return response.data;
  },

  restart: async (): Promise<ManagementRestartResponse> => {
    const response = await api.post<ManagementRestartResponse>('/webui/server/restart');
    return response.data;
  }
};

function buildModelUsageParams(query: ModelUsageQuery = {}) {
  const params: Record<string, string | number> = {};
  if (query.from) params.from = query.from;
  if (query.to) params.to = query.to;
  if (query.provider) params.provider = query.provider;
  if (query.model) params.model = query.model;
  if (query.sessionId) params.session_id = query.sessionId;
  if (query.limit) params.limit = query.limit;
  if (query.scan) params.scan = '1';
  return params;
}

export const modelUsageAPI = {
  stats: async (query: ModelUsageQuery = {}): Promise<ModelUsageStatsResponse> => {
    const response = await api.get<ModelUsageStatsResponse>('/webui/management/usage/stats', {
      params: buildModelUsageParams(query)
    });
    return response.data;
  },

  models: async (query: ModelUsageQuery = {}): Promise<ModelUsageModelsResponse> => {
    const response = await api.get<ModelUsageModelsResponse>('/webui/management/usage/models', {
      params: buildModelUsageParams(query)
    });
    return response.data;
  },

  sessions: async (query: ModelUsageQuery = {}): Promise<ModelUsageSessionsResponse> => {
    const response = await api.get<ModelUsageSessionsResponse>('/webui/management/usage/sessions', {
      params: buildModelUsageParams(query)
    });
    return response.data;
  },

  sessionDetail: async (query: ModelUsageQuery): Promise<ModelUsageSessionDetailResponse> => {
    const response = await api.get<ModelUsageSessionDetailResponse>('/webui/management/usage/session-detail', {
      params: buildModelUsageParams(query)
    });
    return response.data;
  },

  scan: async (provider?: ModelUsageQuery['provider']): Promise<ModelUsageScanResponse> => {
    const response = await api.post<ModelUsageScanResponse>('/webui/management/usage/scan', null, {
      params: provider ? { provider } : {}
    });
    return response.data;
  },

  watchScan: (handlers: {
    onJob?: (job: ModelUsageScanJob) => void;
    onSnapshot?: (jobs: ModelUsageScanJob[]) => void;
    onError?: () => void;
  }) => {
    const eventSource = new EventSource('/v0/webui/management/usage/scan/watch');
    eventSource.onmessage = (event) => {
      try {
        const payload = JSON.parse(String(event.data || '{}'));
        if (payload.type === 'usage-scan-job' && payload.job) {
          handlers.onJob?.(payload.job as ModelUsageScanJob);
        } else if (payload.type === 'usage-scan-snapshot') {
          handlers.onSnapshot?.(Array.isArray(payload.jobs) ? payload.jobs as ModelUsageScanJob[] : []);
        }
      } catch (_error) {
        // Ignore malformed frames.
      }
    };
    eventSource.onerror = () => {
      handlers.onError?.();
    };
    return eventSource;
  }
};

export const sshHostsAPI = {
  listConnections: async (): Promise<any[]> => {
    const response = await api.get<{ ok: boolean; connections: any[] }>('/webui/ssh-connections');
    return response.data.connections || [];
  },
  createConnection: async (payload: any): Promise<any> => {
    const response = await api.post<{ ok: boolean; connection: any }>('/webui/ssh-connections', payload);
    return response.data.connection;
  },
  updateConnection: async (id: string, payload: any): Promise<any> => {
    const response = await api.put<{ ok: boolean; connection: any }>(`/webui/ssh-connections/${encodeURIComponent(id)}`, payload);
    return response.data.connection;
  },
  deleteConnection: async (id: string): Promise<void> => {
    await api.delete(`/webui/ssh-connections/${encodeURIComponent(id)}`);
  },
  testConnection: async (payload: any): Promise<SshHostTestResult> => {
    const response = await api.post<{ ok: boolean; result: SshHostTestResult }>('/webui/ssh-connections/test', payload);
    return response.data.result;
  },
  listWorkspaces: async (): Promise<any[]> => {
    const response = await api.get<{ ok: boolean; workspaces: any[] }>('/webui/ssh-workspaces');
    return response.data.workspaces || [];
  },
  createWorkspace: async (payload: any): Promise<any> => {
    const response = await api.post<{ ok: boolean; workspace: any }>('/webui/ssh-workspaces', payload);
    return response.data.workspace;
  },
  updateWorkspace: async (id: string, payload: any): Promise<any> => {
    const response = await api.put<{ ok: boolean; workspace: any }>(`/webui/ssh-workspaces/${encodeURIComponent(id)}`, payload);
    return response.data.workspace;
  },
  deleteWorkspace: async (id: string): Promise<void> => {
    await api.delete(`/webui/ssh-workspaces/${encodeURIComponent(id)}`);
  },
  browseSshDirectory: async (payload: { connectionId: string; subDir: string }): Promise<any> => {
    const response = await api.post<{ ok: boolean; currentDir: string; parentDir: string; directories: any[] }>('/webui/ssh-hosts/browse', payload);
    return response.data;
  }
};

export default api;
