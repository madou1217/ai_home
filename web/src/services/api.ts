import axios, { AxiosError } from 'axios';
import { createNativeAxiosAdapter } from './native-axios-adapter';
import {
  isNativeServerTransportAvailable,
  openNativeServerSse
} from './native-server-transport';
import { getCurrentControlPlaneProfileId } from './control-plane-selection';
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
  CodexResetCreditsResponse,
  CodexResetOperation,
  CodexResetOperationResponse,
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
  ImageStudioModelsResponse,
  ImageStudioDeleteSessionResponse,
  ImageStudioRunInput,
  ImageStudioRunResponse,
  ImageStudioSessionResponse,
  ImageStudioSessionsResponse,
  NativeSlashCommand,
  Provider,
  SlashCommandsResponse,
  ManagementStatus,
  ManagementMetrics,
  ManagementAccount,
  ManagementAccountsResponse,
  ManagementRestartEvent,
  ManagementRestartResponse,
  ModelUsageBreakdownResponse,
  ModelUsageDashboardQueryCancelResponse,
  ModelUsageDashboardQueryJob,
  ModelUsageDashboardQueryResponse,
  ModelUsageDashboardResponse,
  ModelUsageModelsResponse,
  ModelUsageQuery,
  ModelUsageRequestDetailsResponse,
  ModelUsageScanJob,
  ModelUsageScanResponse,
  ModelUsageSessionDetailResponse,
  ModelUsageSessionsResponse,
  ModelUsageStatsResponse,
  WebUiOpenAIModelsResponse,
  WebUiOpenAIModelsJob,
  WebUiOpenAIModelsRefreshResponse,
  WebUiModelsResponse,
  ToolkitAppConfigResponse,
  ManagedToolsResponse,
  ManagedToolActionResponse,
  ManagedToolLifecycleAction,
  ToolkitToolConfigResponse,
  ManagedAppsResponse,
  ManagedAppUpdateResponse,
  AccountAppLaunchResponse,
  AccountEgressBindingInput,
  AccountEgressResponse,
  AccountEgressRotateResponse,
  AppInstallJob,
  WebUiTask,
  ClientTerminalsResponse,
  EnvironmentsResponse,
  EnvironmentActionInput,
  EnvironmentActionResponse,
  EnvironmentGuideResponse,
  EnvironmentLifecycleAction,
  EnvironmentToolActionResponse,
  MirrorsResponse,
  ProxyStatusResponse,
  ConnectivityResponse,
  ProxyNodesResponse,
  ProxyNode,
  ProxyGroupsResponse,
  ProxyGroupMutationResponse,
  ProxyGroupStrategy,
  ProxySubscriptionsResponse,
  ProxySubscription,
  ProxyMutationResponse,
  ProxySubscriptionSyncResponse,
  NodePingResponse,
  RoutingResponse,
  RoutingRule,
  DedicatedPortsResponse,
  DedicatedPortMutationResponse,
  AggregateExportResponse,
  ProxyCoreStatusResponse,
  ProxyCoreActionResponse,
  NetworkStatusResponse,
  NetworkPlanResponse,
  NetworkApplyResponse,
  ProxyTunConfig,
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
export type KimiDesktopSessionStatus =
  | 'STATUS_PENDING'
  | 'STATUS_SCANNED'
  | 'STATUS_SUCCESS'
  | 'STATUS_EXPIRED';

export interface KimiDesktopSessionStartResponse {
  ok: boolean;
  code?: string;
  qrUrl?: string;
  expiresAtMs?: number;
  error?: string;
}

export interface KimiDesktopSessionPollResponse {
  ok: boolean;
  status?: KimiDesktopSessionStatus;
  error?: string;
}

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

/** 单次请求完成的实时 token 消耗事件（服务端 recordModelUsage 钩子推送）。 */
export interface TokenConsumedEvent {
  provider: string;
  accountRef: string;
  model: string;
  tokens: {
    input: number;
    output: number;
    total: number;
  };
  occurredAt: number;
}

export function dispatchAccountsWatchPayload(payload: any, handlers: {
  onSnapshot?: (payload: AccountsListResponse) => void;
  onSnapshotRequested?: (payload: { requestedAt?: number; hydrating?: boolean }) => void;
  onAccount?: (account: Account) => void;
  onAccountRemoved?: (payload: AccountRemovedEvent) => void;
  onHydrated?: (payload: { hydratedAt?: number }) => void;
  onImportJob?: (job: AccountImportJob) => void;
  onAuthJob?: (job: AccountAddJob) => void;
  onAccountRefreshJob?: (job: AccountRefreshJob) => void;
  onTokenConsumed?: (event: TokenConsumedEvent) => void;
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
    return;
  }
  if (payload.type === 'token-consumed' && payload.accountRef) {
    handlers.onTokenConsumed?.({
      provider: String(payload.provider || ''),
      accountRef: String(payload.accountRef || ''),
      model: String(payload.model || ''),
      tokens: {
        input: Number(payload.tokens?.input) || 0,
        output: Number(payload.tokens?.output) || 0,
        total: Number(payload.tokens?.total) || 0
      },
      occurredAt: Number(payload.occurredAt) || Date.now()
    });
    return;
  }
}

// 账号管理 API
const buildAccountScopedPath = (provider: string, accountRef: string) => (
  `/webui/accounts/${encodeURIComponent(provider)}/${encodeURIComponent(accountRef)}`
);
const buildAccountEgressPath = (provider: string, accountRef: string) => (
  `${buildAccountScopedPath(provider, accountRef)}/egress`
);
const buildAccountEgressRotatePath = (provider: string, accountRef: string) => (
  `${buildAccountScopedPath(provider, accountRef)}/egress/rotate`
);

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
    onTokenConsumed?: (event: TokenConsumedEvent) => void;
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

  listCodexResetCredits: async (accountRef: string): Promise<CodexResetCreditsResponse> => {
    const response = await api.get<CodexResetCreditsResponse>(
      `/webui/accounts/codex/${encodeURIComponent(accountRef)}/reset-credits`
    );
    return response.data;
  },

  consumeCodexResetCredit: async (
    accountRef: string,
    input: { operationId: string; inventoryVersion: string }
  ): Promise<CodexResetOperationResponse> => {
    const response = await api.post<CodexResetOperationResponse>(
      `/webui/accounts/codex/${encodeURIComponent(accountRef)}/reset-credits/consume`,
      input
    );
    return response.data;
  },

  getCodexResetOperation: async (
    accountRef: string,
    operationId: string
  ): Promise<CodexResetOperation> => {
    const response = await api.get<{ ok: boolean; operation: CodexResetOperation }>(
      `/webui/accounts/codex/${encodeURIComponent(accountRef)}/reset-operations/${encodeURIComponent(operationId)}`
    );
    return response.data.operation;
  },

  reconcileCodexResetOperation: async (
    accountRef: string,
    operationId: string
  ): Promise<CodexResetOperationResponse> => {
    const response = await api.post<CodexResetOperationResponse>(
      `/webui/accounts/codex/${encodeURIComponent(accountRef)}/reset-operations/${encodeURIComponent(operationId)}/reconcile`
    );
    return response.data;
  },

  // 打开该账号的 Desktop 应用或新的 CLI 终端窗口
  openApp: async (
    provider: string,
    accountRef: string,
    kind: 'desktop' | 'cli',
    action: 'open' | 'close' = 'open',
    terminalId?: string,
    workdir?: string
  ): Promise<AccountAppLaunchResponse> => {
    const response = await api.post<AccountAppLaunchResponse>(
      `/webui/accounts/${provider}/${accountRef}/open-app`,
      { kind, action, ...(terminalId ? { terminalId } : {}), ...(workdir ? { workdir } : {}) }
    );
    return response.data;
  },

  getAccountEgress: async (provider: string, accountRef: string): Promise<AccountEgressResponse> => {
    const response = await api.get<AccountEgressResponse>(
      buildAccountEgressPath(provider, accountRef)
    );
    return response.data;
  },

  saveAccountEgress: async (
    provider: string,
    accountRef: string,
    binding: AccountEgressBindingInput | null
  ): Promise<AccountEgressResponse> => {
    const response = await api.post<AccountEgressResponse>(
      buildAccountEgressPath(provider, accountRef),
      binding || {}
    );
    return response.data;
  },

  getQuotaResetEvents: async (
    provider: string,
    accountRef: string,
    limit?: number
  ): Promise<{ ok: boolean; provider: string; accountRef: string; events: any[] }> => {
    const query = limit ? `?limit=${encodeURIComponent(limit)}` : '';
    const response = await api.get<{ ok: boolean; provider: string; accountRef: string; events: any[] }>(
      `/webui/accounts/${encodeURIComponent(provider)}/${encodeURIComponent(accountRef)}/quota-reset-events${query}`
    );
    return response.data;
  },

  rotateAccountEgress: async (provider: string, accountRef: string): Promise<AccountEgressRotateResponse> => {
    const response = await api.post<AccountEgressRotateResponse>(
      buildAccountEgressRotatePath(provider, accountRef)
    );
    return response.data;
  },

  startKimiDesktopSession: async (accountRef: string): Promise<KimiDesktopSessionStartResponse> => {
    const response = await api.post<KimiDesktopSessionStartResponse>(
      `/webui/accounts/kimi/${encodeURIComponent(accountRef)}/desktop-session/start`
    );
    return response.data;
  },

  pollKimiDesktopSession: async (
    accountRef: string,
    code: string
  ): Promise<KimiDesktopSessionPollResponse> => {
    const response = await api.post<KimiDesktopSessionPollResponse>(
      `/webui/accounts/kimi/${encodeURIComponent(accountRef)}/desktop-session/poll`,
      { code }
    );
    return response.data;
  },

  listTerminals: async (): Promise<ClientTerminalsResponse> => {
    const response = await api.get<ClientTerminalsResponse>('/webui/terminals');
    return response.data;
  },

  // 宿主机实测的各 Provider 桌面/CLI 入口可用性，附带桌面运行中的账号清单
  listAppEntries: async (options: { refresh?: boolean } = {}): Promise<{
    entries: Record<string, { desktop: boolean; cli: boolean }>;
    capabilities: Record<string, { desktop: boolean; cli: boolean }>;
    runningAccounts: string[];
    runningAccountPids: Record<string, number[]>;
    runningCliAccounts: string[];
    runningCliAccountPids: Record<string, number[]>;
  }> => {
    const response = await api.get<{
      ok: boolean;
      entries: Record<string, { desktop: boolean; cli: boolean }>;
      capabilities?: Record<string, { desktop: boolean; cli: boolean }>;
      runningAccounts?: string[];
      runningAccountPids?: Record<string, number[]>;
      runningCliAccounts?: string[];
      runningCliAccountPids?: Record<string, number[]>;
  }>('/webui/app-entries', options.refresh ? { params: { refresh: '1' } } : undefined);
    return {
      entries: response.data.entries || {},
      capabilities: response.data.capabilities || {},
      runningAccounts: Array.isArray(response.data.runningAccounts) ? response.data.runningAccounts : [],
      runningAccountPids: response.data.runningAccountPids || {},
      runningCliAccounts: Array.isArray(response.data.runningCliAccounts) ? response.data.runningCliAccounts : [],
      runningCliAccountPids: response.data.runningCliAccountPids || {}
    };
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

function isTerminalAppInstallJob(job: AppInstallJob | null | undefined) {
  return Boolean(job && ['succeeded', 'failed', 'cancelled'].includes(String(job.status || '').trim().toLowerCase()));
}

export async function startAppInstallJob(input: {
  provider?: string;
  kind?: 'cli' | 'desktop';
  appId?: string;
}): Promise<AppInstallJob> {
  const response = await api.post<{ ok: boolean; job: AppInstallJob }>('/webui/app-install', input);
  return response.data.job;
}

export async function getAppInstallJob(jobId: string): Promise<AppInstallJob> {
  const response = await api.get<{ ok: boolean; job: AppInstallJob }>(`/webui/app-install/jobs/${encodeURIComponent(jobId)}`);
  return response.data.job;
}

export async function listActiveWebUiTasks(): Promise<WebUiTask[]> {
  const response = await api.get<{ ok: boolean; tasks?: WebUiTask[] }>('/webui/tasks');
  return Array.isArray(response.data.tasks) ? response.data.tasks : [];
}

export function watchWebUiTasks(): EventSource {
  return guardedWebUiEventSource('/v0/webui/tasks/watch');
}

// SSE 是主通道，短轮询只作为断线期间的恢复手段；安装进程始终在服务端
// 后台运行，不会被浏览器请求的生命周期阻塞。
export function waitForAppInstallJob(
  jobId: string,
  onJob?: (job: AppInstallJob) => void
): Promise<AppInstallJob> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const eventSource = guardedWebUiEventSource(
      `/v0/webui/app-install/jobs/${encodeURIComponent(jobId)}/watch`
    );
    const pollTimer = setInterval(() => {
      void getAppInstallJob(jobId).then((job) => {
        onJob?.(job);
        if (isTerminalAppInstallJob(job)) finish(job);
      }).catch(() => {});
    }, 2000);
    const timeoutTimer = setTimeout(() => {
      finish(null, new Error('app_install_watch_timeout'));
    }, 30 * 60 * 1000);

    const finish = (job: AppInstallJob | null, error?: Error) => {
      if (settled) return;
      settled = true;
      clearInterval(pollTimer);
      clearTimeout(timeoutTimer);
      eventSource.close();
      if (error) reject(error);
      else if (job) resolve(job);
      else reject(new Error('app_install_job_missing'));
    };

    eventSource.onmessage = (event) => {
      try {
        const payload = JSON.parse(String(event.data || '{}')) as { job?: AppInstallJob };
        const job = payload.job;
        if (!job) return;
        onJob?.(job);
        if (isTerminalAppInstallJob(job)) finish(job);
      } catch (_error) {
        // Ignore malformed heartbeat/frames; polling remains available.
      }
    };
    eventSource.onerror = () => {
      // EventSource reconnects itself. Do not fail the install because a single
      // SSE connection dropped; the polling fallback keeps terminal state visible.
    };
    void getAppInstallJob(jobId).then((job) => {
      onJob?.(job);
      if (isTerminalAppInstallJob(job)) finish(job);
    }).catch(() => {});
  });
}

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

export interface FileTreeEntry {
  name: string;
  type: 'directory' | 'file';
  size?: number;
  mtime: number;
  hasChildren: boolean;
}

export interface FileTreeResponse {
  path: string;
  projectPath: string;
  entries: FileTreeEntry[];
  truncated: boolean;
}

// 本地文件系统 API
export const fsAPI = {
  tree: async (projectPath: string, path = ''): Promise<FileTreeResponse> => {
    const response = await api.get('/webui/fs/tree', { params: { projectPath, path } });
    return response.data;
  },
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

export interface GitChangedFile {
  path: string;
  oldPath?: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  status: string;
}

export interface GitSummary {
  branch: string;
  upstream: string;
  ahead: number;
  behind: number;
  files: GitChangedFile[];
}

export const gitReviewAPI = {
  summary: async (projectPath: string): Promise<GitSummary> => {
    const response = await api.get('/webui/git/summary', { params: { projectPath } });
    return response.data;
  },
  diff: async (projectPath: string, path: string, staged = false): Promise<{ content: string; truncated: boolean }> => {
    const response = await api.get('/webui/git/diff', { params: { projectPath, path, staged: staged ? 1 : 0 } });
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
  send: async (
    request: ChatRequest,
    options: { timeoutMs?: number } = {}
  ): Promise<ChatResponse> => {
    const timeoutMs = Number(options.timeoutMs);
    const response = await api.post<ChatResponse>('/webui/chat', request, {
      timeout: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : undefined
    });
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
      const profileId = getCurrentControlPlaneProfileId();
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

  decideCliInstallConfirmation: async (
    confirmationId: string,
    decision: 'confirm' | 'cancel'
  ): Promise<void> => {
    await api.post(
      `/webui/chat/cli-install-confirmations/${encodeURIComponent(confirmationId)}`,
      { decision }
    );
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

export const imageStudioAPI = {
  listModels: async (): Promise<ImageStudioModelsResponse> => {
    const response = await api.get<ImageStudioModelsResponse>('/webui/studio/image/models');
    return response.data;
  },

  listSessions: async (): Promise<ImageStudioSessionsResponse> => {
    const response = await api.get<ImageStudioSessionsResponse>('/webui/studio/image/sessions');
    return response.data;
  },

  createSession: async (title = ''): Promise<ImageStudioSessionResponse> => {
    const response = await api.post<ImageStudioSessionResponse>('/webui/studio/image/sessions', { title });
    return response.data;
  },

  getSession: async (sessionId: string): Promise<ImageStudioSessionResponse> => {
    const response = await api.get<ImageStudioSessionResponse>(
      `/webui/studio/image/sessions/${encodeURIComponent(sessionId)}`
    );
    return response.data;
  },

  renameSession: async (sessionId: string, title: string): Promise<ImageStudioSessionResponse> => {
    const response = await api.patch<ImageStudioSessionResponse>(
      `/webui/studio/image/sessions/${encodeURIComponent(sessionId)}`,
      { title }
    );
    return response.data;
  },

  deleteSession: async (sessionId: string): Promise<ImageStudioDeleteSessionResponse> => {
    const response = await api.delete<ImageStudioDeleteSessionResponse>(
      `/webui/studio/image/sessions/${encodeURIComponent(sessionId)}`
    );
    return response.data;
  },

  run: async (sessionId: string, input: ImageStudioRunInput): Promise<ImageStudioRunResponse> => {
    const response = await api.post<ImageStudioRunResponse>(
      `/webui/studio/image/sessions/${encodeURIComponent(sessionId)}/runs`,
      input,
      { timeout: 0 }
    );
    return response.data;
  },

  getAssetBlob: async (sessionId: string, assetId: string, mimeType: string): Promise<Blob> => {
    const response = await api.get<ArrayBuffer>(
      `/webui/studio/image/sessions/${encodeURIComponent(sessionId)}/assets/${encodeURIComponent(assetId)}`,
      { responseType: 'arraybuffer' }
    );
    return new Blob([response.data], { type: mimeType || 'image/png' });
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
  startDashboardQuery: async (query: ModelUsageQuery = {}): Promise<ModelUsageDashboardQueryResponse> => {
    const response = await api.post<ModelUsageDashboardQueryResponse>(
      '/webui/management/usage/dashboard/query',
      null,
      { params: buildModelUsageParams(query) }
    );
    return response.data;
  },

  cancelDashboardQuery: async (jobId: string): Promise<ModelUsageDashboardQueryCancelResponse> => {
    const response = await api.delete<ModelUsageDashboardQueryCancelResponse>(
      `/webui/management/usage/dashboard/query/${encodeURIComponent(jobId)}`
    );
    return response.data;
  },

  watchDashboardQueries: (handlers: {
    onJob?: (job: ModelUsageDashboardQueryJob) => void;
    onSnapshot?: (jobs: ModelUsageDashboardQueryJob[]) => void;
    onError?: () => void;
  }) => {
    const eventSource = guardedWebUiEventSource('/v0/webui/management/usage/dashboard/query/watch');
    eventSource.onmessage = (event) => {
      try {
        dispatchModelUsageDashboardQueryPayload(JSON.parse(String(event.data || '{}')), handlers);
      } catch (_error) {
        // Ignore malformed frames.
      }
    };
    eventSource.onerror = () => {
      handlers.onError?.();
    };
    return eventSource;
  },

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

  requests: async (query: ModelUsageQuery = {}): Promise<ModelUsageRequestDetailsResponse> => {
    const response = await api.get<ModelUsageRequestDetailsResponse>('/webui/management/usage/requests', {
      params: buildModelUsageParams(query)
    });
    return response.data;
  },

  breakdown: async (query: ModelUsageQuery): Promise<ModelUsageBreakdownResponse> => {
    const response = await api.get<ModelUsageBreakdownResponse>('/webui/management/usage/breakdown', {
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

export function dispatchModelUsageDashboardQueryPayload(
  payload: any,
  handlers: {
    onJob?: (job: ModelUsageDashboardQueryJob) => void;
    onSnapshot?: (jobs: ModelUsageDashboardQueryJob[]) => void;
  }
) {
  if (payload?.type === 'usage-dashboard-query-job' && payload.job) {
    handlers.onJob?.(payload.job as ModelUsageDashboardQueryJob);
    return;
  }
  if (payload?.type === 'usage-dashboard-query-snapshot') {
    handlers.onSnapshot?.(
      Array.isArray(payload.jobs) ? payload.jobs as ModelUsageDashboardQueryJob[] : []
    );
  }
}

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

export const toolkitAPI = {
  listApps: async (): Promise<ManagedAppsResponse> => {
    const response = await api.get<ManagedAppsResponse>('/webui/toolkit/apps');
    return response.data;
  },
  checkAppUpdate: async (appId: string): Promise<ManagedAppUpdateResponse> => {
    const response = await api.post<ManagedAppUpdateResponse>(
      `/webui/toolkit/apps/${encodeURIComponent(appId)}/check-update`, {}
    );
    return response.data;
  },
  listTerminals: async (): Promise<ClientTerminalsResponse> => {
    const response = await api.get<ClientTerminalsResponse>('/webui/toolkit/terminals');
    return response.data;
  },
  openTerminal: async (terminalId: string): Promise<{
    ok: boolean;
    status?: string;
    terminalId?: string;
    executable?: string;
    pid?: number | null;
    error?: string;
  }> => {
    const response = await api.post<{
      ok: boolean;
      status?: string;
      terminalId?: string;
      executable?: string;
      pid?: number | null;
      error?: string;
    }>('/webui/toolkit/terminals/open', { terminalId });
    return response.data;
  },
  planTerminalAction: async (terminalId: string, action: 'install' | 'update' | 'uninstall') => {
    const response = await api.post<{ ok: boolean; terminalId?: string; action?: string; label?: string; command?: string; file?: string; args?: string[]; error?: string }>(
      '/webui/toolkit/terminals/plan', { terminalId, action }
    );
    return response.data;
  },
  executeTerminalAction: async (terminalId: string, action: 'install' | 'update' | 'uninstall') => {
    const response = await api.post<{ ok: boolean; accepted?: boolean; alreadyRunning?: boolean; job?: WebUiTask; error?: string }>(
      '/webui/toolkit/terminals/execute', { terminalId, action, confirmed: true }
    );
    return response.data;
  },
  getTerminalJob: async (jobId: string): Promise<WebUiTask> => {
    const response = await api.get<{ ok: boolean; job: WebUiTask }>(
      `/webui/toolkit/terminals/jobs/${encodeURIComponent(jobId)}`
    );
    return response.data.job;
  },
  planAppAction: async (appId: string, action: 'install' | 'update' | 'uninstall', kind?: 'cli' | 'desktop' | 'ide'): Promise<{ ok: boolean; action?: string; label?: string; plans?: Array<{ id: string; label: string; command: string; args: string[] }>; error?: string }> => {
    const response = await api.post<{ ok: boolean; action?: string; label?: string; plans?: Array<{ id: string; label: string; command: string; args: string[] }>; error?: string }>(
      '/webui/toolkit/apps/plan', { appId, action, kind }
    );
    return response.data;
  },
  executeAppAction: async (appId: string, action: 'install' | 'update' | 'uninstall', kind?: 'cli' | 'desktop' | 'ide'): Promise<{ ok: boolean; accepted?: boolean; alreadyRunning?: boolean; job?: AppInstallJob; error?: string }> => {
    const response = await api.post<{ ok: boolean; accepted?: boolean; alreadyRunning?: boolean; job?: AppInstallJob; error?: string }>(
      '/webui/toolkit/apps/install', { appId, action, kind }
    );
    return response.data;
  },
  openManagedApp: async (appId: string, input: { kind: 'cli' | 'desktop'; accountRef?: string; unscoped?: boolean; action?: 'open' | 'close'; terminalId?: string }): Promise<AccountAppLaunchResponse> => {
    const response = await api.post<AccountAppLaunchResponse>(
      `/webui/toolkit/apps/${encodeURIComponent(appId)}/open`, input
    );
    return response.data;
  },
  openManagedDesktopApp: async (appId: string): Promise<AccountAppLaunchResponse> => {
    return toolkitAPI.openManagedApp(appId, { kind: 'desktop' });
  },
  installApp: async (provider: string): Promise<{ ok: boolean; accepted?: boolean; alreadyRunning?: boolean; job?: AppInstallJob; result?: any }> => {
    const response = await api.post<{ ok: boolean; accepted?: boolean; alreadyRunning?: boolean; job?: AppInstallJob; result?: any }>('/webui/toolkit/apps/install', { appId: provider, action: 'install' });
    return response.data;
  },
  installHooks: async (providers: string[]): Promise<{ ok: boolean; results: any[] }> => {
    const response = await api.post<{ ok: boolean; results: any[] }>('/webui/toolkit/apps/hooks', { providers });
    return response.data;
  },
  getAppConfig: async (appId: string): Promise<ToolkitAppConfigResponse> => {
    const response = await api.get<ToolkitAppConfigResponse>(`/webui/toolkit/apps/${encodeURIComponent(appId)}/config`);
    return response.data;
  },
  saveAppConfig: async (appId: string, content: string, revision: string): Promise<ToolkitAppConfigResponse> => {
    const response = await api.put<ToolkitAppConfigResponse>(`/webui/toolkit/apps/${encodeURIComponent(appId)}/config`, {
      content,
      revision
    });
    return response.data;
  },
  listTools: async (): Promise<ManagedToolsResponse> => {
    const response = await api.get<ManagedToolsResponse>('/webui/toolkit/tools');
    return response.data;
  },
  getToolConfig: async (toolId: string): Promise<ToolkitToolConfigResponse> => {
    const response = await api.get<ToolkitToolConfigResponse>(`/webui/toolkit/tools/${encodeURIComponent(toolId)}/config`);
    return response.data;
  },
  saveToolConfig: async (toolId: string, content: string, revision: string, targetRevision: string): Promise<ToolkitToolConfigResponse> => {
    const response = await api.put<ToolkitToolConfigResponse>(`/webui/toolkit/tools/${encodeURIComponent(toolId)}/config`, {
      content,
      revision,
      targetRevision
    });
    return response.data;
  },
  planManagedToolAction: async (
    toolId: string,
    action: ManagedToolLifecycleAction
  ): Promise<ManagedToolActionResponse> => {
    const response = await api.post<ManagedToolActionResponse>('/webui/toolkit/tools/plan', {
      toolId,
      action
    });
    return response.data;
  },
  executeManagedToolAction: async (
    toolId: string,
    action: ManagedToolLifecycleAction
  ): Promise<ManagedToolActionResponse> => {
    const response = await api.post<ManagedToolActionResponse>('/webui/toolkit/tools/execute', {
      toolId,
      action,
      confirmed: true
    });
    return response.data;
  },
  getManagedToolJob: async (jobId: string): Promise<WebUiTask> => {
    const response = await api.get<{ ok: boolean; job: WebUiTask }>(
      `/webui/toolkit/tools/jobs/${encodeURIComponent(jobId)}`
    );
    return response.data.job;
  },
  getEnvironments: async (): Promise<EnvironmentsResponse> => {
    const response = await api.get<EnvironmentsResponse>('/webui/toolkit/environments');
    return response.data;
  },
  getEnvironmentGuide: async (platform?: string): Promise<EnvironmentGuideResponse> => {
    const response = await api.get<EnvironmentGuideResponse>('/webui/toolkit/environments/guide', {
      params: platform ? { platform } : undefined
    });
    return response.data;
  },
  planEnvironmentToolAction: async (
    toolId: string,
    action: EnvironmentLifecycleAction
  ): Promise<EnvironmentToolActionResponse> => {
    const response = await api.post<EnvironmentToolActionResponse>('/webui/toolkit/environments/plan', {
      toolId,
      action
    });
    return response.data;
  },
  executeEnvironmentToolAction: async (
    toolId: string,
    action: EnvironmentLifecycleAction
  ): Promise<EnvironmentToolActionResponse> => {
    const response = await api.post<EnvironmentToolActionResponse>('/webui/toolkit/environments/execute', {
      toolId,
      action,
      confirmed: true
    });
    return response.data;
  },
  getEnvironmentJob: async (jobId: string): Promise<WebUiTask> => {
    const response = await api.get<{ ok: boolean; job: WebUiTask }>(
      `/webui/toolkit/environments/jobs/${encodeURIComponent(jobId)}`
    );
    return response.data.job;
  },
  planEnvironmentAction: async (input: EnvironmentActionInput): Promise<EnvironmentActionResponse> => {
    const response = await api.post<EnvironmentActionResponse>('/webui/toolkit/environments/plan', input);
    return response.data;
  },
  executeEnvironmentAction: async (input: EnvironmentActionInput): Promise<EnvironmentActionResponse> => {
    const response = await api.post<EnvironmentActionResponse>('/webui/toolkit/environments/execute', input);
    return response.data;
  },
  getMirrors: async (): Promise<MirrorsResponse> => {
    const response = await api.get<MirrorsResponse>('/webui/toolkit/mirrors');
    return response.data;
  },
  setMirror: async (type: 'npm' | 'pip', url: string): Promise<{ ok: boolean; registry?: string; indexUrl?: string; error?: string }> => {
    const response = await api.post<{ ok: boolean; registry?: string; indexUrl?: string; error?: string }>('/webui/toolkit/mirrors/set', { type, url });
    return response.data;
  },
  pingMirror: async (url: string): Promise<{ ok: boolean; latencyMs: number; statusCode?: number | null; measurement?: 'ttfb'; route?: 'direct'; error?: string | null }> => {
    const response = await api.post<{ ok: boolean; latencyMs: number; error?: string }>('/webui/toolkit/mirrors/ping', { url });
    return response.data;
  },
  getProxy: async (): Promise<ProxyStatusResponse> => {
    const response = await api.get<ProxyStatusResponse>('/webui/toolkit/proxy');
    return response.data;
  },
  setProxy: async (target: 'git' | 'npm', proxyUrl: string): Promise<{ ok: boolean; error?: string | null; message?: string; operations?: Array<{ key: string; ok: boolean; exitCode: number | null; stderr: string }> }> => {
    const response = await api.post<{ ok: boolean }>('/webui/toolkit/proxy/set', { target, proxyUrl });
    return response.data;
  },
  testConnectivity: async (params: { route?: 'direct' | 'proxy'; proxyUrl?: string } = {}): Promise<ConnectivityResponse> => {
    const response = await api.get<ConnectivityResponse>('/webui/toolkit/connectivity', { params });
    return response.data;
  }
};

export const proxyPoolAPI = {
  listNodes: async (params: { group?: string; protocol?: string } = {}): Promise<ProxyNodesResponse> => {
    const response = await api.get<ProxyNodesResponse>('/webui/toolkit/proxy-pool/nodes', { params });
    return response.data;
  },
  listGroups: async (): Promise<ProxyGroupsResponse> => {
    const response = await api.get<ProxyGroupsResponse>('/webui/toolkit/proxy-pool/groups');
    return response.data;
  },
  upsertGroup: async (group: {
    id?: string;
    name: string;
    icon?: string;
    nodeIds: string[];
    strategy?: ProxyGroupStrategy;
    failoverStrategy?: ProxyGroupStrategy;
  }): Promise<ProxyGroupMutationResponse> => {
    const response = await api.post<ProxyGroupMutationResponse>(
      '/webui/toolkit/proxy-pool/groups',
      group
    );
    return response.data;
  },
  updateGroupPolicy: async (
    id: string,
    policy: { strategy: ProxyGroupStrategy; failoverStrategy: ProxyGroupStrategy }
  ): Promise<ProxyGroupMutationResponse> => {
    const response = await api.post<ProxyGroupMutationResponse>(
      '/webui/toolkit/proxy-pool/groups/policy',
      { id, ...policy }
    );
    return response.data;
  },
  deleteGroup: async (groupId: string): Promise<ProxyGroupMutationResponse> => {
    const response = await api.delete<ProxyGroupMutationResponse>(
      `/webui/toolkit/proxy-pool/groups/${encodeURIComponent(groupId)}`
    );
    return response.data;
  },
  upsertNode: async (node: Partial<ProxyNode>): Promise<{ ok: boolean; node: ProxyNode; uri?: string }> => {
    const response = await api.post<{ ok: boolean; node: ProxyNode; uri?: string }>('/webui/toolkit/proxy-pool/nodes', node);
    return response.data;
  },
  deleteNode: async (nodeId: string): Promise<ProxyMutationResponse> => {
    const response = await api.delete<ProxyMutationResponse>(`/webui/toolkit/proxy-pool/nodes/${encodeURIComponent(nodeId)}`);
    return response.data;
  },
  importNodes: async (content: string, subscriptionId?: string): Promise<{ ok: boolean; count: number; nodes: ProxyNode[]; error?: string }> => {
    const response = await api.post<{ ok: boolean; count: number; nodes: ProxyNode[]; error?: string }>('/webui/toolkit/proxy-pool/import', { content, subscriptionId });
    return response.data;
  },
  listSubscriptions: async (): Promise<ProxySubscriptionsResponse> => {
    const response = await api.get<ProxySubscriptionsResponse>('/webui/toolkit/proxy-pool/subscriptions');
    return response.data;
  },
  upsertSubscription: async (sub: Partial<ProxySubscription>): Promise<{ ok: boolean; subscription: ProxySubscription }> => {
    const response = await api.post<{ ok: boolean; subscription: ProxySubscription }>('/webui/toolkit/proxy-pool/subscriptions', sub);
    return response.data;
  },
  syncSubscription: async (
    id: string,
    options: { storageOnly?: boolean } = {}
  ): Promise<ProxySubscriptionSyncResponse> => {
    const response = await api.post<ProxySubscriptionSyncResponse>(
      '/webui/toolkit/proxy-pool/subscriptions/sync',
      { id, storageOnly: options.storageOnly === true }
    );
    return response.data;
  },
  deleteSubscription: async (id: string): Promise<ProxyMutationResponse> => {
    const response = await api.delete<ProxyMutationResponse>(`/webui/toolkit/proxy-pool/subscriptions/${encodeURIComponent(id)}`);
    return response.data;
  },
  pingNode: async (nodeId: string): Promise<NodePingResponse> => {
    const response = await api.post<NodePingResponse>('/webui/toolkit/proxy-pool/ping', { nodeId });
    return response.data;
  },
  pingAllNodes: async (filter: { group?: string; protocol?: string } = {}): Promise<{ ok: boolean; testedCount: number; results: Record<string, { ok: boolean; latencyMs: number }> }> => {
    const response = await api.post<{ ok: boolean; testedCount: number; results: Record<string, { ok: boolean; latencyMs: number }> }>('/webui/toolkit/proxy-pool/ping', { filter });
    return response.data;
  },
  getRouting: async (): Promise<RoutingResponse> => {
    const response = await api.get<RoutingResponse>('/webui/toolkit/proxy-pool/routing');
    return response.data;
  },
  setRouting: async (payload: { mode?: 'global' | 'rule' | 'direct'; activeOutboundNodeId?: string | null; rules?: RoutingRule[] }): Promise<RoutingResponse> => {
    const response = await api.post<RoutingResponse>('/webui/toolkit/proxy-pool/routing', payload);
    return response.data;
  },
  getDedicatedPorts: async (): Promise<DedicatedPortsResponse> => {
    const response = await api.get<DedicatedPortsResponse>('/webui/toolkit/proxy-pool/dedicated-ports');
    return response.data;
  },
  toggleDedicatedPort: async (nodeId: string, enabled: boolean, requestedPort?: number): Promise<DedicatedPortMutationResponse> => {
    const response = await api.post<DedicatedPortMutationResponse>('/webui/toolkit/proxy-pool/dedicated-ports/toggle', { nodeId, enabled, requestedPort });
    return response.data;
  },
  exportAggregate: async (params: { format?: 'mihomo' | 'base64'; group?: string; raw?: boolean } = {}): Promise<AggregateExportResponse> => {
    const response = await api.get<AggregateExportResponse>('/webui/toolkit/proxy-pool/export', { params });
    return response.data;
  },
  getCoreStatus: async (): Promise<ProxyCoreStatusResponse> => {
    const response = await api.get<ProxyCoreStatusResponse>('/webui/toolkit/proxy-pool/core');
    return response.data;
  },
  startCore: async (): Promise<ProxyCoreActionResponse> => {
    const response = await api.post<ProxyCoreActionResponse>('/webui/toolkit/proxy-pool/core/start');
    return response.data;
  },
  stopCore: async (): Promise<ProxyCoreActionResponse> => {
    const response = await api.post<ProxyCoreActionResponse>('/webui/toolkit/proxy-pool/core/stop');
    return response.data;
  },
  reloadCore: async (): Promise<ProxyCoreActionResponse> => {
    const response = await api.post<ProxyCoreActionResponse>('/webui/toolkit/proxy-pool/core/reload');
    return response.data;
  },
  planCoreInstall: async (input: { platform?: string; arch?: string } = {}): Promise<{
    ok: boolean;
    plan?: { planId: string; version: string; platform: string; arch: string; assetName: string; digest: string; size: number; official: boolean; managed: boolean };
    error?: string;
    message?: string;
  }> => {
    const response = await api.post('/webui/toolkit/proxy-pool/core/install/plan', input);
    return response.data;
  },
  executeCoreInstall: async (planId: string, confirmed: boolean): Promise<{
    ok: boolean;
    version?: string;
    digest?: string;
    error?: string;
    message?: string;
  }> => {
    const response = await api.post('/webui/toolkit/proxy-pool/core/install/execute', { planId, confirmed });
    return response.data;
  },
  uninstallManagedCore: async (confirmed: boolean): Promise<{ ok: boolean; removed?: boolean; error?: string }> => {
    const response = await api.post('/webui/toolkit/proxy-pool/core/uninstall', { confirmed });
    return response.data;
  },
  getNetworkStatus: async (): Promise<NetworkStatusResponse> => {
    const response = await api.get<NetworkStatusResponse>('/webui/toolkit/proxy-pool/network/status');
    return response.data;
  },
  planNetwork: async (input: {
    kind?: 'system-proxy' | 'tun';
    action: 'enable' | 'disable' | 'restore';
    service?: string;
    proxyUrl?: string;
    tun?: Partial<ProxyTunConfig>;
  }): Promise<NetworkPlanResponse> => {
    const response = await api.post<NetworkPlanResponse>('/webui/toolkit/proxy-pool/network/plan', input);
    return response.data;
  },
  applyNetwork: async (planId: string, snapshotHash: string, confirmed: boolean): Promise<NetworkApplyResponse> => {
    const response = await api.post<NetworkApplyResponse>('/webui/toolkit/proxy-pool/network/apply', {
      planId,
      expectedSnapshotHash: snapshotHash,
      confirmed
    });
    return response.data;
  }
};

export default api;
