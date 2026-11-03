import api from '@/services/api';
import type { EdgeApplyResult, EdgeNginxMode, EdgePlan, EdgeProvider, EdgeStatus } from './types';

const BASE = '/webui/toolkit/edge';
// 失败也是**结构化**结果（edge_config_rejected / edge_config_not_writable…），
// 校验/回滚细节必须原样给到界面，所以不把 4xx/5xx 变成异常。
const READ_ALL = { validateStatus: () => true };

export interface EdgePlanInput {
  provider: EdgeProvider;
  domain?: string;
  mode?: EdgeNginxMode;
  remotePort?: number;
  udp?: boolean;
}

export const edgeProxyAPI = {
  /** 本机装了哪些边缘件、配置在哪、能不能写、AIH 端口是多少。 */
  async status() {
    return (await api.get<EdgeStatus>(BASE, READ_ALL)).data;
  },
  /** 只生成、不落盘：拿到的就是 apply 会写进去的那份内容。 */
  async plan(input: EdgePlanInput) {
    const params: Record<string, string> = { provider: input.provider };
    if (input.domain) params.domain = input.domain;
    if (input.mode) params.mode = input.mode;
    if (input.remotePort) params.remotePort = String(input.remotePort);
    if (input.udp === false) params.udp = '0';
    return (await api.get<{ ok: boolean; plan: EdgePlan; error?: string }>(`${BASE}/plan`, { ...READ_ALL, params })).data;
  },
  /** 落盘：备份 → 写入 → 校验 → 重载；校验不过整体回滚（最长等校验子进程 ~15s）。 */
  async apply(input: EdgePlanInput & { reload?: boolean }) {
    return (await api.post<EdgeApplyResult>(`${BASE}/apply`, input, { ...READ_ALL, timeout: 60000 })).data;
  }
};
