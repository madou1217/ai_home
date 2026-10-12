import api from '@/services/api';
import type {
  AggregatorDraftNode,
  AggregatorLatency,
  AggregatorProbeResult,
  AggregatorSourceNode,
  AggregatorFormat,
  AggregatorImportLinks,
  AggregatorLocalClients,
  AggregatorOverview,
  AggregatorPreview,
  AggregatorProfile,
  AggregatorProfileInput,
  AggregatorRouteTrace,
  AggregatorSourceInput,
  AggregatorSourcePreview,
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
  /** 编辑中（未保存）的配置会选中哪些节点：自建组勾选节点、实时匹配名称规则用。 */
  async previewNodes(draft: Pick<AggregatorProfileInput, 'sources' | 'filter' | 'naming' | 'dedupe'>) {
    return (await api.post<{ ok: boolean; nodes: AggregatorDraftNode[] }>(`${BASE}/profiles/nodes`, draft)).data;
  },
  /** 规则测试：编辑中的配置下，一个网址 / 域名 / IP 会命中哪条规则、走哪个组（第一次要下载规则集）。 */
  async testRoute(profile: AggregatorProfileInput, target: string) {
    return (await api.post<AggregatorRouteTrace>(`${BASE}/profiles/test-route`, { profile, target }, { timeout: 60000 })).data;
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
  /** 解析预览：粘贴或拖入的本地内容会识别成什么、导入哪些节点（不保存）。 */
  async previewSource(content: string) {
    return (await api.post<AggregatorSourcePreview>(`${BASE}/sources/preview`, { content }, { timeout: 30000 })).data;
  },
  /** 订阅源里的节点（节点表格）。 */
  async sourceNodes(subscriptionId: string) {
    return (await api.get<{ ok: boolean; nodes: AggregatorSourceNode[] }>(`${BASE}/sources/${encodeURIComponent(subscriptionId)}/nodes`)).data;
  },
  /** 从服务器测 TCP 建连耗时；fresh 忽略几分钟内的缓存结果。 */
  async measureLatency(subscriptionId: string, fresh = false) {
    return (await api.post<{ ok: boolean; results: Record<string, AggregatorLatency> }>(
      `${BASE}/sources/${encodeURIComponent(subscriptionId)}/latency`, { fresh }, { timeout: 120000 }
    )).data;
  },
  /** 探针：只知道地址时猜协议（DNS、TCP、TLS、SOCKS5、HTTP CONNECT、SSH）。 */
  async probe(host: string, ports: number[]) {
    return (await api.post<AggregatorProbeResult>(`${BASE}/probe`, { host, ports }, { timeout: 120000 })).data;
  },
  /** 解析分享链接或配置，返回带全部字段的节点（填进手动节点表单）。 */
  async parseNodes(content: string) {
    return (await api.post<{ ok: boolean; format: string; nodes: Array<Record<string, unknown>>; skippedNodes: Array<{ name: string; reason: string }> }>(
      `${BASE}/nodes/parse`, { content }
    )).data;
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
