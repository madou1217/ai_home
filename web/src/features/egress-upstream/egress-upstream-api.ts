import api from '@/services/api';
import type { EgressActionResult, EgressRule, EgressUpstreamView } from './types';

const BASE = '/webui/egress-upstreams';

// 动作接口在池未就绪 / 上游不存在时返回 4xx + { ok:false, error }：当成结果交给界面，而不是异常。
async function call(method: 'post' | 'put', path: string, body?: unknown): Promise<EgressActionResult> {
  try {
    return (await api[method]<EgressActionResult>(path, body || {})).data;
  } catch (error: unknown) {
    const data = (error as { response?: { data?: EgressActionResult } }).response?.data;
    if (data && typeof data === 'object') return data;
    throw error;
  }
}

const itemPath = (id: string) => `${BASE}/${encodeURIComponent(id)}`;

export const egressUpstreamAPI = {
  async view(accountRef?: string): Promise<EgressUpstreamView> {
    const query = accountRef ? `?accountRef=${encodeURIComponent(accountRef)}` : '';
    return (await api.get<EgressUpstreamView>(`${BASE}${query}`)).data;
  },
  savePolicy(id: string, body: { rules?: Partial<EgressRule>[]; evidenceTtlMs?: number; credentialedProbe?: boolean }) {
    return call('put', itemPath(id), body);
  },
  probe(id: string, nodes?: string[]) {
    return call('post', `${itemPath(id)}/probe`, nodes && nodes.length ? { nodes } : {});
  },
  resetEvidence(id: string, exitKeys?: string[]) {
    return call('post', `${itemPath(id)}/evidence/reset`, exitKeys && exitKeys.length ? { exitKeys } : {});
  },
  refreshNetwork() {
    return call('post', `${BASE}/network/refresh`);
  }
};
