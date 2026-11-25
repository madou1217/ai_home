import api from '@/services/api';

export type ClipboardKind = 'text' | 'link' | 'image' | 'file';

export interface ClipboardItem {
  id: string;
  sha256: string;
  kind: ClipboardKind;
  mime: string;
  byteSize: number;
  width?: number;
  height?: number;
  preview: string;
  thumbnailDataUrl?: string;
  files?: string[];
  sourceDevice?: string;
  sourceApp?: string;
  pinned: boolean;
  deleted: boolean;
  seenCount: number;
  createdAtMs: number;
  lastSeenAtMs: number;
  syncedAtMs?: number;
  remoteId?: string;
}

export interface ClipboardItemDetail extends ClipboardItem {
  text?: string;
  textTruncated?: boolean;
  blobPath?: string;
}

export interface ClipboardSettings {
  captureEnabled: boolean;
  syncEnabled: boolean;
  syncTargetProfileId: string;
  retentionDays: number;
  maxItems: number;
  maxItemBytes: number;
}

export type ClipboardSettingsPatch = Partial<ClipboardSettings>;

export interface ClipboardDevice {
  id: string;
  name: string;
  platform: string;
  lastSeenAtMs: number;
}

export interface ClipboardCaptureStatus {
  enabled: boolean;
  supported: boolean;
  running: boolean;
  reason?: string;
}

export interface ClipboardSyncStatus {
  enabled: boolean;
  targetProfileId?: string;
  lastSyncAtMs?: number;
  lastError?: string;
}

export interface ClipboardTransportStatus {
  name: string;
  available: boolean;
  detail?: string;
}

export interface ClipboardStatus {
  platform: string;
  capture: ClipboardCaptureStatus;
  sync: ClipboardSyncStatus;
  deviceId: string;
  deviceName: string;
  keyFingerprint: string;
  transports: ClipboardTransportStatus[];
  itemCount: number;
  pinnedCount: number;
  devices?: ClipboardDevice[];
}

export interface ClipboardServerProfile {
  id: string;
  label: string;
  endpoint: string;
  active: boolean;
}

export interface ListClipboardItemsParams {
  limit?: number;
  before?: number;
  kind?: ClipboardKind;
  q?: string;
  includeDeleted?: boolean;
}

// Default axios instance in '@/services/api' already sets baseURL = '/v0',
// so '/webui/clipboard' resolves to '/v0/webui/clipboard'.
const BASE = '/webui/clipboard';

export function extractClipboardErrorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === 'object') {
    const maybeAxios = error as {
      response?: { data?: { error?: { message?: string; code?: string } | string } };
      message?: string;
    };
    const errPayload = maybeAxios.response?.data?.error;
    if (typeof errPayload === 'string' && errPayload.trim()) {
      return errPayload.trim();
    }
    if (errPayload && typeof errPayload === 'object') {
      if (typeof errPayload.message === 'string' && errPayload.message.trim()) {
        return errPayload.message.trim();
      }
      if (typeof errPayload.code === 'string' && errPayload.code.trim()) {
        return errPayload.code.trim();
      }
    }
    if (typeof maybeAxios.message === 'string' && maybeAxios.message.trim()) {
      return maybeAxios.message.trim();
    }
  }
  return fallback;
}

export const clipboardAPI = {
  listItems: async (params: ListClipboardItemsParams = {}): Promise<ClipboardItem[]> => {
    const response = await api.get<{ items?: ClipboardItem[] }>(`${BASE}/items`, { params });
    return Array.isArray(response.data?.items) ? response.data.items : [];
  },

  getItem: async (id: string): Promise<ClipboardItemDetail> => {
    const response = await api.get<{ item: ClipboardItemDetail }>(
      `${BASE}/items/${encodeURIComponent(id)}`
    );
    return response.data.item;
  },

  getItemContentText: async (id: string): Promise<string> => {
    const response = await api.get<string>(`${BASE}/items/${encodeURIComponent(id)}/content`, {
      responseType: 'text',
      // Prevent axios from JSON.parse-ing clipboard text that happens to be valid JSON.
      transformResponse: [(data: unknown) => (typeof data === 'string' ? data : String(data ?? ''))]
    });
    return response.data;
  },

  getItemContentBlob: async (id: string): Promise<{ blob: Blob; contentType: string }> => {
    const response = await api.get<Blob>(`${BASE}/items/${encodeURIComponent(id)}/content`, {
      responseType: 'blob'
    });
    const rawHeader = response.headers['content-type'];
    const raw = response.data;
    const contentType =
      typeof rawHeader === 'string' && rawHeader.trim()
        ? rawHeader.split(';')[0].trim()
        : raw.type || 'application/octet-stream';
    const blob = raw.type === contentType ? raw : new Blob([raw], { type: contentType });
    return { blob, contentType };
  },

  deleteItem: async (id: string): Promise<void> => {
    await api.delete(`${BASE}/items/${encodeURIComponent(id)}`);
  },

  pinItem: async (id: string, pinned: boolean): Promise<ClipboardItem> => {
    const response = await api.post<{ item: ClipboardItem }>(
      `${BASE}/items/${encodeURIComponent(id)}/pin`,
      { pinned }
    );
    return response.data.item;
  },

  getSettings: async (): Promise<ClipboardSettings> => {
    const response = await api.get<{ settings: ClipboardSettings }>(`${BASE}/settings`);
    return response.data.settings;
  },

  patchSettings: async (patch: ClipboardSettingsPatch): Promise<ClipboardSettings> => {
    const response = await api.patch<{ settings: ClipboardSettings }>(`${BASE}/settings`, patch);
    return response.data.settings;
  },

  getStatus: async (): Promise<ClipboardStatus> => {
    const response = await api.get<ClipboardStatus>(`${BASE}/status`);
    return response.data;
  },

  listServers: async (): Promise<ClipboardServerProfile[]> => {
    const response = await api.get<{ servers?: ClipboardServerProfile[] }>(`${BASE}/servers`);
    return Array.isArray(response.data?.servers) ? response.data.servers : [];
  },

  triggerSync: async (): Promise<void> => {
    await api.post(`${BASE}/sync-run`, {});
  }
};
