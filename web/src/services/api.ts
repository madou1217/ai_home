import axios, { AxiosError } from 'axios';
import type {
  Account,
  AddAccountRequest,
  AddAccountResponse,
  AccountAddJob,
  UsageConfig,
  ServerConfig,
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
  AggregatedProject,
  ArchivedSession
  ,
  SessionMessageBundle,
  SessionEventsResponse,
  SessionEventItem
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

// 账号管理 API
export const accountsAPI = {
  // 获取所有账号
  list: async (): Promise<{ accounts: Account[]; hydrating: boolean }> => {
    const response = await api.get<{ ok: boolean; accounts: Account[]; hydrating?: boolean }>('/webui/accounts');
    return {
      accounts: response.data.accounts,
      hydrating: Boolean(response.data.hydrating)
    };
  },

  watch: (handlers: {
    onSnapshot?: (payload: { accounts: Account[]; hydrating?: boolean }) => void;
    onAccount?: (account: Account) => void;
    onHydrated?: (payload: { hydratedAt?: number }) => void;
    onError?: () => void;
  }) => {
    const eventSource = new EventSource('/v0/webui/accounts/watch');
    eventSource.onmessage = (event) => {
      try {
        const payload = JSON.parse(String(event.data || '{}'));
        if (payload.type === 'snapshot') {
          handlers.onSnapshot?.({
            accounts: Array.isArray(payload.accounts) ? payload.accounts : [],
            hydrating: Boolean(payload.hydrating)
          });
          return;
        }
        if (payload.type === 'account' && payload.account) {
          handlers.onAccount?.(payload.account as Account);
          return;
        }
        if (payload.type === 'hydrated') {
          handlers.onHydrated?.({
            hydratedAt: Number(payload.hydratedAt) || 0
          });
        }
      } catch (_error) {
        // Ignore malformed SSE frames.
      }
    };
    eventSource.onerror = () => {
      handlers.onError?.();
    };
    return eventSource;
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

  reauth: async (provider: string, accountId: string): Promise<AddAccountResponse> => {
    const response = await api.post<AddAccountResponse>(`/webui/accounts/${provider}/${accountId}/reauth`);
    return response.data;
  },

  refreshUsage: async (provider: string, accountId: string): Promise<Account> => {
    const response = await api.post<{ ok: boolean; account: Account }>(`/webui/accounts/${provider}/${accountId}/refresh-usage`);
    return response.data.account;
  },

  // 删除账号
  delete: async (provider: string, accountId: string) => {
    const response = await api.delete(`/webui/accounts/${provider}/${accountId}`);
    return response.data;
  },

  // 导出账号
  export: async () => {
    const response = await api.get('/webui/accounts/export', { responseType: 'blob' });
    const contentType = response.headers['content-type'] || 'application/json';
    const url = URL.createObjectURL(new Blob([response.data], { type: contentType }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'ai-home-accounts.json';
    a.click();
    URL.revokeObjectURL(url);
  },

  // 导入账号
  import: async (data: any) => {
    const response = await api.post('/webui/accounts/import', data);
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

// 会话管理 API
export const sessionsAPI = {
  // 获取所有聚合项目
  getAllProjects: async (): Promise<AggregatedProject[]> => {
    const response = await api.get<{ ok: boolean; projects: AggregatedProject[] }>('/webui/projects');
    return response.data.projects;
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
  }
};

// 模型列表 API（按 provider 分组）
export const modelsAPI = {
  listByProvider: async (): Promise<Record<string, string[]>> => {
    const response = await api.get<{ ok: boolean; models: Record<string, string[]> }>('/webui/models');
    return response.data.models || {};
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

  sendRunInput: async (runId: string, input: string, appendNewline = true) => {
    const response = await api.post(`/webui/chat/runs/${encodeURIComponent(runId)}/input`, {
      input,
      appendNewline
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
    const response = await api.get<ManagementStatus>('/management/status');
    return response.data;
  },

  // 获取服务器指标
  metrics: async (): Promise<ManagementMetrics> => {
    const response = await api.get<ManagementMetrics>('/management/metrics');
    return response.data;
  },

  accounts: async (): Promise<ManagementAccountsResponse> => {
    const response = await api.get<ManagementAccountsResponse>('/management/accounts');
    return response.data;
  },

  watch: (handlers: {
    onSnapshot?: (payload: {
      status: ManagementStatus;
      metrics: ManagementMetrics;
      accounts: ManagementAccount[];
    }) => void;
    onError?: () => void;
  }) => {
    const eventSource = new EventSource('/v0/management/watch');
    eventSource.onmessage = (event) => {
      try {
        const payload = JSON.parse(String(event.data || '{}'));
        if (payload.type === 'snapshot') {
          handlers.onSnapshot?.({
            status: payload.status as ManagementStatus,
            metrics: payload.metrics as ManagementMetrics,
            accounts: Array.isArray(payload.accounts) ? payload.accounts as ManagementAccount[] : []
          });
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

  // 重新加载账号
  reload: async () => {
    const response = await api.post('/management/reload');
    return response.data;
  },

  // 清除冷却时间
  clearCooldown: async () => {
    const response = await api.post('/management/cooldown/clear');
    return response.data;
  },

  restart: async () => {
    const response = await api.post('/webui/server/restart');
    return response.data;
  }
};

export default api;
