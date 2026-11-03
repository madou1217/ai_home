import api from '@/services/api';

const BASE = '/webui/geo-resources';

export interface GeoResourceCapabilities {
  country: boolean;
  region: boolean;
  city: boolean;
  asn: boolean;
}

export interface GeoResource {
  id: string;
  name: string;
  role: string;
  kind: string;
  sizeHint: string;
  url: string;
  autoDownload: boolean;
  capabilities: GeoResourceCapabilities;
  installed: boolean;
  bytes: number;
  updatedAt: number;
  path: string;
}

/** 一个 provider 的可用性（数据文件在不在、能提供哪些字段）。 */
export interface GeoProviderAvailability {
  id: string;
  name: string;
  capabilities: GeoResourceCapabilities;
  available: boolean;
  error: string;
}

export interface GeoResourceJob {
  id: string;
  source: string;
  taskName: string;
  appId: string;
  toolId: string;
  action: string;
  status: string;
  phase: string;
  progress: { percent: number; label: string };
  attempts: Array<{ id: string; label: string; ok: boolean; error: string }>;
  error: string;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
}

export interface GeoResourceView {
  ok: boolean;
  resources: GeoResource[];
  providers: GeoProviderAvailability[];
  jobs: GeoResourceJob[];
}

export const geoResourceAPI = {
  async view(): Promise<GeoResourceView> {
    return (await api.get<GeoResourceView>(BASE)).data;
  },
  /** 启动下载 / 更新 / 删除；返回作业（进度走 watchJob）。 */
  async start(resourceId: string, action: 'install' | 'update' | 'uninstall') {
    return (await api.post<{ ok: boolean; job?: GeoResourceJob; error?: string }>(
      `${BASE}/jobs`, { resourceId, action }
    )).data;
  },
  async cancel(jobId: string) {
    return (await api.post<{ ok: boolean; error?: string }>(`${BASE}/jobs/${encodeURIComponent(jobId)}/cancel`)).data;
  }
};
