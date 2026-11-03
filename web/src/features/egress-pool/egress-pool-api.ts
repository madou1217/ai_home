import api from '@/services/api';
import type { EgressPoolActionResult, EgressPoolView } from './types';

const BASE = '/webui/egress-pool';

// 动作接口在池未就绪等情况下返回 409 + { ok:false, error }：把它当成结果交给界面，而不是异常。
async function postAction(path: string, body?: unknown): Promise<EgressPoolActionResult> {
  try {
    return (await api.post<EgressPoolActionResult>(path, body || {})).data;
  } catch (error: unknown) {
    const data = (error as { response?: { data?: EgressPoolActionResult } }).response?.data;
    if (data && typeof data === 'object') return data;
    throw error;
  }
}

export interface EgressPoolViewQuery {
  page?: number;
  pageSize?: number;
  filter?: string;
  query?: string;
  /** 上一份数据的版本指纹：没变时服务端回 304，直接沿用缓存。 */
  version?: string;
}

export const egressPoolAPI = {
  /**
   * 出口池视图。带 page 时走**服务端分页**（2w 节点的全量视图有十几 MB，
   * 前端每 5 秒拉一次等于持续占带宽）；不带 page 时是全量（旧行为）。
   * 带 version 时若服务端判定没变化会回 304，此时返回 null，调用方沿用上一份数据。
   */
  async view(query: EgressPoolViewQuery = {}): Promise<EgressPoolView | null> {
    const params: Record<string, string | number> = {};
    if (query.page !== undefined) {
      params.page = query.page;
      params.pageSize = query.pageSize ?? 50;
      params.filter = query.filter || 'all';
      if (query.query) params.query = query.query;
    }
    const headers = query.version ? { 'if-none-match': `W/"${query.version}"` } : undefined;
    const response = await api.get<EgressPoolView>(BASE, {
      params: Object.keys(params).length ? params : undefined,
      headers,
      // 304 不是错误：交给调用方沿用上一份数据。
      validateStatus: (status) => status === 304 || (status >= 200 && status < 300)
    });
    if (response.status === 304) return null;
    return response.data;
  },
  probe(node?: string) {
    return postAction(`${BASE}/probe`, node ? { node } : {});
  },
  select(node: string) {
    return postAction(`${BASE}/nodes/${encodeURIComponent(node)}/select`);
  },
  clearCooldown(node: string) {
    return postAction(`${BASE}/nodes/${encodeURIComponent(node)}/clear-cooldown`);
  },
  /** 手动关闭 / 放行一个节点（按出口身份记，重启后仍有效）。 */
  setBlocked(node: string, blocked: boolean) {
    return postAction(`${BASE}/nodes/${encodeURIComponent(node)}/${blocked ? 'block' : 'unblock'}`);
  },
  /** 改拦截策略：延迟阈值开关 + 阈值、连不上开关。 */
  updatePolicy(patch: { latency?: { enabled?: boolean; maxMs?: number }; unreachable?: { enabled?: boolean } }) {
    return postAction(`${BASE}/node-policy`, patch);
  },
  /** 放行全部手动关闭的节点。 */
  clearDisabled() {
    return postAction(`${BASE}/node-policy/clear-disabled`);
  }
};
