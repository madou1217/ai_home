import api from '@/services/api';
import type { EgressAccountProbeResult, EgressActionResult, EgressDiagnostics, EgressRule, EgressUpstreamView } from './types';

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
  /** 按账号当前生效出口（出口池车道 / 代理地址 / 系统代理 / 直连）真实探测一次上游。 */
  async probeAccount(id: string, accountRef: string): Promise<EgressAccountProbeResult> {
    return (await call('post', `${itemPath(id)}/probe-account`, { accountRef })) as EgressAccountProbeResult;
  },
  resetEvidence(id: string, exitKeys?: string[]) {
    return call('post', `${itemPath(id)}/evidence/reset`, exitKeys && exitKeys.length ? { exitKeys } : {});
  },
  refreshNetwork() {
    return call('post', `${BASE}/network/refresh`);
  },
  /** 只读冲突诊断：池端口/进程身份、外部代理内核、端口占用。 */
  async diagnostics(): Promise<EgressDiagnostics> {
    return (await api.get<EgressDiagnostics>(`${BASE}/diagnostics`)).data;
  }
};
