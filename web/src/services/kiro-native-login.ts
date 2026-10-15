import api from './api';

// kiro 原生登录（设备码 / refresh_token）的 WebUI 入口 —— 不经过本地 kiro CLI / Kiro IDE。
//
// 单独成文件而不是塞进 api.ts：这三个端点只属于「加账号」这条链路，且服务端返回体刻意
// **不含 client_secret / deviceCode**（见 lib/server/webui-kiro-login.js），类型即契约。

export interface KiroNativeLoginStartResponse {
  ok: boolean;
  error?: string;
  flowId?: string;
  userCode?: string;
  verificationUri?: string;
  verificationUriComplete?: string;
  intervalSeconds?: number;
  expiresAtMs?: number;
}

export type KiroNativeLoginPollStatus = 'pending' | 'slow_down' | 'expired' | 'denied' | 'authorized';

export interface KiroNativeLoginPollResponse {
  ok: boolean;
  status?: KiroNativeLoginPollStatus;
  accountRef?: string;
  cliAccountId?: string;
  error?: string;
}

export interface KiroRefreshTokenImportResponse {
  ok: boolean;
  accountRef?: string;
  cliAccountId?: string;
  error?: string;
}

export const kiroNativeLoginAPI = {
  start: async (payload: { region?: string; startUrl?: string } = {}): Promise<KiroNativeLoginStartResponse> => {
    const response = await api.post<KiroNativeLoginStartResponse>(
      '/webui/accounts/kiro/login/start',
      payload
    );
    return response.data;
  },

  poll: async (flowId: string): Promise<KiroNativeLoginPollResponse> => {
    const response = await api.post<KiroNativeLoginPollResponse>(
      '/webui/accounts/kiro/login/poll',
      { flowId }
    );
    return response.data;
  },

  importRefreshToken: async (payload: {
    refreshToken: string;
    profileArn?: string;
    region?: string;
    provider?: string;
  }): Promise<KiroRefreshTokenImportResponse> => {
    const response = await api.post<KiroRefreshTokenImportResponse>(
      '/webui/accounts/kiro/login/refresh-token',
      payload
    );
    return response.data;
  }
};
