import axios, { AxiosError } from 'axios';
import { createNativeAxiosAdapter } from './native-axios-adapter';
import {
  isNativeServerTransportAvailable,
  openNativeServerSse
} from './native-server-transport';
import { getActiveControlPlaneProfileId } from './control-plane-selection';
import { buildAppHref } from './app-navigation';
import { collectAllSessionHistoryMessages } from './session-history-window.js';
import { SessionRequestCoordinator } from './session-request-coordinator.js';
import {
  guardedWebUiEventSource,
  resolveActiveServer,
  resolveWebUiManagementKey
} from './webui-auth-transport';
export {
  fetchAuthorizedWebUiResource,
  guardedWebUiEventSource,
  resolveActiveServer,
  resolveWebUiManagementKey
} from './webui-auth-transport';
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
  Provider,
  SlashCommandsResponse,
  ManagementStatus,
  ManagementMetrics,
  ManagementAccount,
  ManagementAccountsResponse,
  ManagementRestartEvent,
  ManagementRestartResponse,
  ModelUsageDashboardResponse,
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
  ArchivedSessionsResponse,
  ProviderSessionLifecycleCapability,
  SessionMessageBundle,
  SessionEventsResponse,
  SessionEventItem,
  SshHostTestResult,
  InteractivePrompt
} from '@/types';

const api = axios.create({
  baseURL: '/v0',
  timeout: 30000,
  ...(isNativeServerTransportAvailable() ? { adapter: createNativeAxiosAdapter() } : {})
});

function redirectToWebUiGate() {
  try {
    if (typeof window === 'undefined') return;
    if ((window.location.pathname || '').includes('/server-setup')) return;
    window.location.href = buildAppHref('/server-setup', 'gate=1');
  } catch (_error) { /* ignore */ }
}

const SESSION_HISTORY_PAGE_LIMIT = 50;
const sessionRequests = new SessionRequestCoordinator();

api.interceptors.request.use((config) => {
  // R2 鉴权门：为本 server 的请求附加 Management Key。
  const gateToken = resolveWebUiManagementKey();
  const active = resolveActiveServer();
  if (gateToken || active.isRemote) {
    const headers: any = config.headers ?? {};
    const setHeader = (name: string, value: string) => {
      if (typeof headers.set === 'function') { if (!headers.get?.(name)) headers.set(name, value); }
      else if (!headers[name]) headers[name] = value;
    };
    if (gateToken) setHeader('Authorization', `Bearer ${gateToken}`);
    // R1 薄壳：远端 server 时带上目标 id，本地 server 据此透明转发。
    if (active.isRemote && active.serverId) setHeader('x-aih-server-id', active.serverId);
    config.headers = headers;
  }

  return config;
});

api.interceptors.response.use(
  (response) => response,
  (error: AxiosError) => {
    // R2 鉴权门：缺少或无效 Management Key → 引导去 Server 设置页。
    const response = error.response;
    if ([401, 503].includes(Number(response?.status))
      && (response?.data as { error?: unknown } | undefined)?.error === 'webui_unauthorized') {
      redirectToWebUiGate();
    }
    return Promise.reject(error);
  }
);

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
      accountRef: String(payload.accountRef || ''),
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
    const eventSource = guardedWebUiEventSource('/v0/webui/accounts/watch');
    eventSource.onmessage = (event) => {
      try {
        dispatchAccountsWatchPayload(JSON.parse(String(event.data || '{}')), handlers);
      } catch (_error) {
        // Ignore malformed SSE frames.
      }
    };
    eventSource.onerror = () => handlers.onError?.();

    return {
      close: () => eventSource.close()
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

  confirmCliInstall: async (jobId: string): Promise<AccountAddJob> => {
    const response = await api.post<{ ok: boolean; job: AccountAddJob }>(
      `/webui/accounts/add/jobs/${jobId}/install`
    );
    return response.data.job;
  },

  completeBrowserCallback: async (jobId: string, callbackUrl: string): Promise<AccountAddJob> => {
    const response = await api.post<{ ok: boolean; job: AccountAddJob }>(
      `/webui/accounts/add/jobs/${jobId}/callback`,
      { callbackUrl }
    );
    return response.data.job;
  },

  reauth: async (provider: string, accountRef: string): Promise<AddAccountResponse> => {
    const response = await api.post<AddAccountResponse>(`/webui/accounts/${provider}/${accountRef}/reauth`);
    return response.data;
  },

  refreshUsage: async (provider: string, accountRef: string): Promise<AccountRefreshUsageResponse> => {
    const response = await api.post<AccountRefreshUsageResponse>(`/webui/accounts/${provider}/${accountRef}/refresh-usage`);
    return response.data;
  },

  requestSnapshot: async (): Promise<AccountsSnapshotRequestResponse> => {
    const response = await api.post<AccountsSnapshotRequestResponse>('/webui/accounts/watch/snapshot');
    return response.data;
  },

  updateStatus: async (provider: string, accountRef: string, status: 'up' | 'down'): Promise<Account> => {
    const response = await api.post<{ ok: boolean; account: Account }>(`/webui/accounts/${provider}/${accountRef}/status`, { status });
    return response.data.account;
  },

  updateAccount: async (provider: string, accountRef: string, data: { apiKey?: string; baseUrl?: string; authMode?: string; credentialType?: string }): Promise<{ ok: boolean; account: Account }> => {
    const response = await api.post<{ ok: boolean; account: Account }>(`/webui/accounts/${provider}/${accountRef}/update`, data);
    return response.data;
  },

  setDefault: async (provider: string, accountRef: string): Promise<Account> => {
    const response = await api.post<{ ok: boolean; account: Account }>(`/webui/accounts/${provider}/${accountRef}/set-default`);
    return response.data.account;
  },

  clearDefault: async (provider: string, accountRef: string): Promise<Account> => {
    const response = await api.post<{ ok: boolean; account: Account }>(`/webui/accounts/${provider}/${accountRef}/clear-default`);
    return response.data.account;
  },

  setMobile: async (provider: string, accountRef: string): Promise<Account> => {
    const response = await api.post<{ ok: boolean; account: Account }>(`/webui/accounts/${provider}/${accountRef}/set-mobile`);
    return response.data.account;
  },

  clearMobile: async (provider: string, accountRef: string): Promise<Account> => {
    const response = await api.post<{ ok: boolean; account: Account }>(`/webui/accounts/${provider}/${accountRef}/clear-mobile`);
    return response.data.account;
  },

  // 删除账号
  delete: async (provider: string, accountRef: string) => {
    const response = await api.delete(`/webui/accounts/${provider}/${accountRef}`);
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

export type FileTrustScope = 'file_directory' | 'parent_directory';

export interface FileTrustCandidate {
  scope: FileTrustScope;
  path: string;
  label: string;
  description: string;
}

export interface FileAccessAuthorization {
  required: boolean;
  filePath: string;
  candidates: FileTrustCandidate[];
}

export interface FileRequestError {
  code: string;
  message: string;
  authorization?: FileAccessAuthorization;
}

interface FileMetadataResponse {
  path: string;
  size: number;
  mtime: number;
}

export function parseFileRequestError(error: unknown): FileRequestError {
  const source = error as {
    message?: unknown;
    response?: { data?: { error?: unknown; message?: unknown; authorization?: FileAccessAuthorization } };
  };
  const payload = source?.response?.data;
  return {
    code: String(payload?.error || 'file_request_failed'),
    message: String(payload?.message || source?.message || '加载失败'),
    ...(payload?.authorization ? { authorization: payload.authorization } : {})
  };
}

// 本地文件系统 API
export const fsAPI = {
  read: async (path: string, projectPath?: string, source?: string): Promise<FileMetadataResponse & { content: string }> => {
    // source 用于后端选择受控根目录，例如 Codex memory citation 不应按当前项目解析。
    const response = await api.get('/webui/fs/read', { params: { path, projectPath, source } });
    return response.data;
  },
  checkAccess: async (path: string, projectPath?: string, source?: string): Promise<FileMetadataResponse> => {
    const response = await api.get('/webui/fs/access', { params: { path, projectPath, source } });
    return response.data;
  },
  trust: async (path: string, scope: FileTrustScope, source?: string): Promise<{ trustedRoot: string; filePath: string }> => {
    const response = await api.post('/webui/fs/trust', { path, scope, source });
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

  updateServer: async (config: Partial<ServerConfig>) => {
    const response = await api.post<{ ok: boolean; config: ServerConfig }>('/webui/server-config', { config });
    return response.data.config;
  },

  rotateManagementKey: async (managementKey: string, authorizationKey = '') => {
    const response = await api.post<{
      ok: boolean;
      managementKeyConfigured: boolean;
      rotatedAt: number;
    }>('/webui/server-config/management-key/rotate', { managementKey }, {
      ...(authorizationKey
        ? { headers: { Authorization: `Bearer ${authorizationKey}` } }
        : {})
    });
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

export const serverProfilesAPI = {
  listEndpointHints: async (): Promise<ControlPlaneEndpointHintsResponse> => {
    const response = await api.get<ControlPlaneEndpointHintsResponse>('/webui/control-plane/endpoints');
    return {
      ok: response.data.ok,
      endpoints: response.data.endpoints || [],
      warnings: response.data.warnings || []
    };
  }
};

// 会话管理 API
export const sessionsAPI = {
  // 获取所有聚合项目
  getAllProjects: async (): Promise<AggregatedProject[]> => {
    const response = await api.get<{ ok: boolean; projects: AggregatedProject[] }>('/webui/projects');
    return response.data.projects;
  },

  getProjectSessions: async (projectPath: string): Promise<AggregatedProject> => {
    const params = new URLSearchParams({ projectPath });
    const response = await api.get<{ ok: boolean; project: AggregatedProject }>(
      `/webui/projects/sessions?${params.toString()}`
    );
    return response.data.project;
  },

  watchProjects: (handlers: {
    onSnapshot?: (payload: { revision: number; updatedAt: number; projects: AggregatedProject[] }) => void;
    onRuntime?: (runningSessionKeys: Set<string>) => void;
    onConnected?: () => void;
    onError?: () => void;
  }) => {
    const eventSource = guardedWebUiEventSource('/v0/webui/projects/watch');
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

  getSessionLifecycleCapabilities: async (): Promise<Partial<Record<Provider, ProviderSessionLifecycleCapability>>> => {
    const response = await api.get<{
      ok: boolean;
      providers: Partial<Record<Provider, ProviderSessionLifecycleCapability>>;
    }>('/webui/sessions/lifecycle-capabilities');
    return response.data.providers || {};
  },

  // 归档会话：服务端只接受 provider + sessionId，不携带账号或客户端路径。
  archiveSession: async (provider: string, sessionId: string) => {
    const response = await api.post('/webui/sessions/archive', {
      provider, sessionId
    });
    return response.data;
  },

  // 获取 session 的消息内容
  getSessionMessages: async (provider: string, sessionId: string, projectDirName?: string, accountRef?: string): Promise<ChatMessage[]> => {
    return collectAllSessionHistoryMessages((page: { before?: number }) => (
      sessionsAPI.getSessionMessagesBundle(provider, sessionId, projectDirName, {
        ...page,
        limit: SESSION_HISTORY_PAGE_LIMIT,
        accountRef
      })
    ));
  },

  getSessionMessagesBundle: async (
    provider: string,
    sessionId: string,
    projectDirName?: string,
    options: { before?: number; limit?: number; accountRef?: string } = {}
  ): Promise<SessionMessageBundle> => {
    const params = new URLSearchParams();
    if (projectDirName) params.set('projectDirName', projectDirName);
    if (options.accountRef) params.set('accountRef', options.accountRef);
    if (Number.isInteger(options.before) && Number(options.before) >= 0) {
      params.set('before', String(options.before));
    }
    params.set('limit', String(
      Number.isInteger(options.limit) && Number(options.limit) > 0
        ? options.limit
        : SESSION_HISTORY_PAGE_LIMIT
    ));
    const query = params.toString();
    const url = `/webui/sessions/${provider}/${sessionId}/messages${query ? `?${query}` : ''}`;
    return sessionRequests.run(
      `/v0${url}`,
      async () => {
        const response = await api.get<{
          ok: boolean;
          messages: ChatMessage[];
          cursor: number;
          start: number;
          total: number;
          hasMore: boolean;
        }>(url);
        return {
          messages: response.data.messages || [],
          cursor: Number(response.data.cursor) || 0,
          start: Math.max(0, Number(response.data.start) || 0),
          total: Math.max(0, Number(response.data.total) || 0),
          hasMore: Boolean(response.data.hasMore)
        };
      }
    );
  },

  // 惰性批量取「模型 + 最后消息预览」，只传当前展开分组的可见会话（≤40）。
  getSessionPreviews: async (
    sessions: Array<{ provider: string; id: string; projectDirName?: string }>
  ): Promise<Array<{
    provider: Provider;
    id: string;
    projectDirName?: string;
    model?: string;
    preview?: string;
  }>> => {
    if (!sessions || sessions.length === 0) return [];
    const response = await api.post<{
      ok: boolean;
      previews?: Array<{
        provider: Provider;
        id: string;
        projectDirName?: string;
        model?: string;
        preview?: string;
      }>;
    }>(
      '/webui/sessions/previews',
      { sessions }
    );
    return (response.data && response.data.previews) || [];
  },

  getSessionEvents: async (
    provider: string,
    sessionId: string,
    cursor: number,
    projectDirName?: string
  ): Promise<{
    events: SessionEventItem[];
    cursor: number;
    requiresSnapshot?: boolean;
    hasAssistantToolCall?: boolean;
  }> => {
    const params = new URLSearchParams();
    params.set('cursor', String(Math.max(0, Number(cursor) || 0)));
    if (projectDirName) {
      params.set('projectDirName', projectDirName);
    }
    const url = `/webui/sessions/${provider}/${sessionId}/events?${params.toString()}`;
    return sessionRequests.run(
      `/v0${url}`,
      async () => {
        const response = await api.get<SessionEventsResponse>(url);
        return {
          events: response.data.events || [],
          cursor: Number(response.data.cursor) || 0,
          requiresSnapshot: Boolean(response.data.requiresSnapshot),
          hasAssistantToolCall: Boolean(response.data.hasAssistantToolCall)
        };
      }
    );
  },

  // 该会话最近一次实际使用的模型（服务端持久化，跟随当前 server；无记录返回空）。
  getLastModel: async (provider: string, sessionId: string): Promise<string> => {
    if (!provider || !sessionId) return '';
    try {
      const response = await api.get<{ ok: boolean; model?: string }>(
        `/webui/sessions/${provider}/${sessionId}/model`
      );
      return String(response.data?.model || '');
    } catch {
      return '';
    }
  },

  // 获取原生归档和仍可恢复的历史归档。
  getArchivedSessions: async (): Promise<ArchivedSessionsResponse> => {
    const response = await api.get<{
      ok: boolean;
      archived: ArchivedSession[];
      errors?: ArchivedSessionsResponse['errors'];
    }>('/webui/sessions/archived');
    return {
      archived: response.data.archived || [],
      errors: response.data.errors || []
    };
  },

  // 还原归档会话
  unarchiveSession: async (provider: string, sessionId: string, origin: ArchivedSession['origin']) => {
    const response = await api.post('/webui/sessions/unarchive', {
      provider, sessionId, origin
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
    byAccountRef: response.data.byAccountRef || {},
    selectableByAccountRef: response.data.selectableByAccountRef || {},
    defaultByAccountRef: response.data.defaultByAccountRef || {},
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
      byAccountRef: response.data.byAccountRef || {},
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
    const eventSource = guardedWebUiEventSource('/v0/webui/openai-models/watch');
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
    if (isNativeServerTransportAvailable()) {
      const profileId = getActiveControlPlaneProfileId();
      if (!profileId) throw new Error('missing_active_server_profile');
      const handle = await openNativeServerSse({
        profileId,
        method: 'POST',
        path: '/v0/webui/chat',
        body: request,
        accept: 'text/event-stream',
        contentType: 'application/json',
        signal: options.signal
      }, {
        onEvent: (event) => {
          const payload = String(event.data || '').trim();
          if (!payload || payload === '[DONE]') return;
          const parsed = JSON.parse(payload) as ChatStreamEvent;
          options.onEvent?.(parsed);
          if (parsed.type === 'error') {
            throw new Error(parsed.message || parsed.code || 'chat_stream_failed');
          }
        }
      });
      await handle.done;
      return;
    }
    // 关键：聊天流必须跟随当前激活 server——裸 fetch 不走 axios 拦截器,需自带 x-aih-server-id,
    // 否则远端视图里发消息会打到本地 server，拿远端 accountRef 去配本地账号会直接失败。
    const activeServer = resolveActiveServer();
    const gateToken = resolveWebUiManagementKey();
    const response = await fetch('/v0/webui/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        ...(gateToken ? { Authorization: `Bearer ${gateToken}` } : {}),
        ...(activeServer.isRemote && activeServer.serverId
          ? { 'x-aih-server-id': activeServer.serverId }
          : {})
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
        accountRef: data?.accountRef,
        gateway: Boolean(data?.gateway),
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

  // 审批决策(P3):对挂起的权限请求回 allow/deny。
  decideApproval: async (runId: string, approvalId: string, decision: 'allow' | 'deny', messageText = '') => {
    const response = await api.post(
      `/webui/chat/runs/${encodeURIComponent(runId)}/approvals/${encodeURIComponent(approvalId)}`,
      { decision, message: messageText }
    );
    return response.data;
  },

  // mid-run 插话(P2c):运行中向当前 run 注入下一条 user 消息(claude native 支持,
  // 同会话下一轮排队语义;不支持的 run 服务端返回 native_steer_unsupported)。
  steerRun: async (runId: string, text: string) => {
    const response = await api.post(`/webui/chat/runs/${encodeURIComponent(runId)}/input`, {
      input: text,
      mode: 'steer'
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

  // 列出某会话仍在服务端跑的 native run（detached：刷新/断连后 run 未死）。
  // 页面打开会话时据此恢复"运行中"状态与待回答的交互 prompt。
  listActiveRuns: async (
    sessionId: string,
    provider?: string,
    projectDirName?: string
  ): Promise<Array<{ runId: string; provider: string; accountRef: string; sessionId: string; startedAt: number; interactionMode: string; activePrompt: InteractivePrompt | null }>> => {
    if (!sessionId) return [];
    try {
      const params: Record<string, string> = { sessionId };
      if (provider) params.provider = provider;
      if (projectDirName) params.projectDirName = projectDirName;
      const response = await api.get<{ ok: boolean; runs: any[] }>('/webui/chat/runs', { params });
      return Array.isArray(response.data?.runs) ? response.data.runs : [];
    } catch {
      return [];
    }
  },

  // 【显式 stop】真正终止运行中的原生会话。仅关 SSE（controller.abort）是"被动断连"，服务端只
  // detach 不 kill（长任务不被腰斩）；要真正停止必须调这个 abort 端点。
  abortRun: async (runId: string) => {
    if (!runId) return;
    try {
      await api.post(`/webui/chat/runs/${encodeURIComponent(runId)}/abort`, {});
    } catch (_error) {
      // 幂等：run 可能已完成/清理，忽略。
    }
  },

  getSlashCommands: async (provider: string): Promise<NativeSlashCommand[]> => {
    const response = await api.get<SlashCommandsResponse>(`/webui/slash-commands?provider=${encodeURIComponent(provider)}`);
    return response.data.commands || [];
  }
};

// VSCode 风格底部终端：交互式 shell PTY（POST 写 + SSE 读）。
//
// 终端连的是「当前激活的 server」——本机激活就是本机的 shell，远端激活(如 AWS)就是那台机器的
// shell（PTY 在目标 server 上创建，pickShell 用目标机的 process.platform，Windows/Mac/Linux 自动对）。
// 这需要:①POST/SSE 都带 x-aih-server-id 指向目标 server；②本地代理把 SSE **边收边转**(见
// webui-server-proxy 的流式分支),否则远端终端流会被缓冲成永远「连接中」。
// fetch-stream 可以携带自定义头，Management Key 与 server-id 都不进入 URL。
async function terminalPost(path: string, body: unknown): Promise<any> {
  try {
    const response = await api.post(`/webui/terminal/${path}`, body);
    return response.data;
  } catch (error) {
    const status = Number((error as AxiosError)?.response?.status) || 0;
    return { ok: false, error: status ? `terminal_http_${status}` : 'terminal_request_failed' };
  }
}

export const terminalAPI = {
  open: async (
    cols: number,
    rows: number,
    muxId?: string,
    cwd?: string
  ): Promise<{ ok: boolean; termId?: string; muxId?: string; shell?: string; error?: string }> =>
    terminalPost('open', { cols, rows, muxId, cwd }),
  input: (termId: string, data: string) => terminalPost('input', { termId, data }),
  resize: (termId: string, cols: number, rows: number) => terminalPost('resize', { termId, cols, rows }),
  close: (termId: string) => terminalPost('close', { termId }),
  // 整个面板一条 SSE，承载所有 tab 的输出（帧带 termId），规避浏览器每域 ~6 连接上限。
  // Management Key 与远端 server id 均通过 header 传递，不进入 URL。
  openMuxStream: (muxId: string): EventSource => guardedWebUiEventSource(
    `/v0/webui/terminal/mux?muxId=${encodeURIComponent(muxId)}`
  )
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
    const eventSource = guardedWebUiEventSource('/v0/webui/management/watch');
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
  dashboard: async (query: ModelUsageQuery = {}): Promise<ModelUsageDashboardResponse> => {
    const response = await api.get<ModelUsageDashboardResponse>('/webui/management/usage/dashboard', {
      params: buildModelUsageParams(query)
    });
    return response.data;
  },

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
    const eventSource = guardedWebUiEventSource('/v0/webui/management/usage/scan/watch');
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
