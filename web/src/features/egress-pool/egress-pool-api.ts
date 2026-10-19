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

export const egressPoolAPI = {
  async view(): Promise<EgressPoolView> {
    return (await api.get<EgressPoolView>(BASE)).data;
  },
  probe(node?: string) {
    return postAction(`${BASE}/probe`, node ? { node } : {});
  },
  select(node: string) {
    return postAction(`${BASE}/nodes/${encodeURIComponent(node)}/select`);
  },
  clearCooldown(node: string) {
    return postAction(`${BASE}/nodes/${encodeURIComponent(node)}/clear-cooldown`);
  }
};
