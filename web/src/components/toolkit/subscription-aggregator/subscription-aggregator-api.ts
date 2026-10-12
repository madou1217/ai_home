import api from '@/services/api';
import type {
  AggregatorFormat,
  AggregatorImportLinks,
  AggregatorLocalClients,
  AggregatorOverview,
  AggregatorPreview,
  AggregatorProfile,
  AggregatorProfileInput,
  AggregatorSourceInput,
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
  /** client：模拟某个客户端（它的内核版本、视图等），预览结果就是它实际拿到的内容。 */
  async preview(profileId: string, format: AggregatorFormat, client = '') {
    const params = client ? { format, client } : { format };
    return (await api.get<AggregatorPreview>(`${BASE}/profiles/${encodeURIComponent(profileId)}/preview`, { params })).data;
  },
  /** origin：订阅地址用的服务地址（扫码时选局域网地址）。 */
  async importLinks(profileId: string, origin: string) {
    return (await api.get<AggregatorImportLinks>(`${BASE}/profiles/${encodeURIComponent(profileId)}/import-links`, { params: { origin } })).data;
  },
  async localClients() {
    return (await api.get<AggregatorLocalClients>(`${BASE}/local-clients`)).data;
  },
  async saveSource(source: AggregatorSourceInput) {
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
