import api from '@/services/api';
import type {
  AggregatorFormat,
  AggregatorOverview,
  AggregatorPreview,
  AggregatorProfile,
  AggregatorProfileInput,
  AggregatorSourceSaveResult,
  AggregatorSyncResult
} from './types';

const BASE = '/webui/toolkit/subscription-aggregator';

export const subscriptionAggregatorAPI = {
  async overview() {
    return (await api.get<AggregatorOverview>(BASE)).data;
  },
  async saveProfile(profile: AggregatorProfileInput) {
    return (await api.post<{ ok: boolean; profile: AggregatorProfile }>(`${BASE}/profiles`, profile)).data;
  },
  async deleteProfile(profileId: string) {
    return (await api.delete<{ ok: boolean }>(`${BASE}/profiles/${encodeURIComponent(profileId)}`)).data;
  },
  async rotateToken(profileId: string) {
    return (await api.post<{ ok: boolean; profile: AggregatorProfile }>(`${BASE}/profiles/${encodeURIComponent(profileId)}/token`)).data;
  },
  async preview(profileId: string, format: AggregatorFormat) {
    return (await api.get<AggregatorPreview>(`${BASE}/profiles/${encodeURIComponent(profileId)}/preview`, { params: { format } })).data;
  },
  async saveSource(source: { id?: string; name: string; url: string }) {
    // 新增订阅会立即同步一次，给足上游抓取时间。
    return (await api.post<AggregatorSourceSaveResult>(`${BASE}/sources`, source, { timeout: 60000 })).data;
  },
  async deleteSource(subscriptionId: string) {
    return (await api.delete<{ ok: boolean; error?: string }>(`${BASE}/sources/${encodeURIComponent(subscriptionId)}`)).data;
  },
  async syncSource(subscriptionId: string) {
    return (await api.post<AggregatorSyncResult>(`${BASE}/sources/${encodeURIComponent(subscriptionId)}/sync`, {}, { timeout: 60000 })).data;
  },
  async syncAllSources() {
    return (await api.post<{ ok: boolean; results: Record<string, AggregatorSyncResult> }>(`${BASE}/sources/sync`, {}, { timeout: 120000 })).data;
  }
};
