import axios from 'axios';
import type { Account, AccountConfig, UsageConfig, ChatMessage, ChatRequest, ChatResponse, ServerStatus, ServerMetrics, AggregatedProject, ArchivedSession } from '@/types';

const api = axios.create({
  baseURL: '/v0',
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json'
  }
});

// 账号管理 API
export const accountsAPI = {
  // 获取所有账号
  list: async (): Promise<Account[]> => {
    const response = await api.get<{ ok: boolean; accounts: Account[] }>('/webui/accounts');
    return response.data.accounts;
  },

  // 添加新账号
  add: async (provider: string, accountId: string, config?: AccountConfig) => {
    const response = await api.post('/webui/accounts/add', {
      provider,
      accountId,
      config
    });
    return response.data;
  },

  // 删除账号
  delete: async (provider: string, accountId: string) => {
    const response = await api.delete(`/webui/accounts/${provider}/${accountId}`);
    return response.data;
  },

  // 导出账号
  export: async () => {
    const response = await api.get('/webui/accounts/export', { responseType: 'blob' });
    const url = URL.createObjectURL(new Blob([JSON.stringify(response.data, null, 2)], { type: 'application/json' }));
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
    let url = `/webui/sessions/${provider}/${sessionId}/messages`;
    if (projectDirName) {
      url += `?projectDirName=${encodeURIComponent(projectDirName)}`;
    }
    const response = await api.get<{ ok: boolean; messages: ChatMessage[] }>(url);
    return response.data.messages;
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
  }
};

// 管理 API
export const managementAPI = {
  // 获取服务器状态
  status: async (): Promise<ServerStatus> => {
    const response = await api.get<ServerStatus>('/management/status');
    return response.data;
  },

  // 获取服务器指标
  metrics: async (): Promise<ServerMetrics> => {
    const response = await api.get<ServerMetrics>('/management/metrics');
    return response.data;
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
  }
};

export default api;
