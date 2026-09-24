import type { ControlPlaneProfile, ControlPlaneProfileState } from '@/types';

/**
 * Server 列表的纯展示映射（桌面 ControlPlaneServerList 与移动端 MobileServers 共用）：
 * 只映射真实的 profile.state 与同步时间戳，不额外发明「在线心跳」。
 */
export type ControlPlaneStatusTone = 'ready' | 'degraded' | 'offline';

export const CONTROL_PLANE_PROFILE_STATUS: Record<ControlPlaneProfileState, { tone: ControlPlaneStatusTone; label: string }> = {
  ready: { tone: 'ready', label: '就绪' },
  degraded: { tone: 'degraded', label: '连接异常' },
  offline: { tone: 'offline', label: '离线' }
};

export const getControlPlaneProfileStatus = (state: ControlPlaneProfileState) => (
  CONTROL_PLANE_PROFILE_STATUS[state] || CONTROL_PLANE_PROFILE_STATUS.offline
);

export const SERVER_PENDING_AUTH_LABEL = '已发现，待授权';

export interface ControlPlaneServerMetrics {
  /** degraded 或存在 lastError：实时数据无法获取，只能展示上次缓存 */
  unavailable: boolean;
  cachedSummary: string;
  accounts: { active: number; total: number; schedulable: number } | null;
  sessions: number | null;
}

export function summarizeControlPlaneServerMetrics(profile: ControlPlaneProfile): ControlPlaneServerMetrics {
  const unavailable = profile.state === 'degraded' || Boolean(profile.lastError);
  const cachedSummary = [
    profile.lastStatusSyncAt > 0 ? `账号 ${profile.accountCount}` : '',
    profile.lastSessionsSyncAt > 0 ? `会话 ${profile.sessionCount}` : ''
  ].filter(Boolean).join(' · ');
  return {
    unavailable,
    cachedSummary,
    accounts: profile.lastStatusSyncAt > 0
      ? {
          active: profile.activeAccountCount,
          total: profile.accountCount,
          schedulable: profile.lastAccountsSyncAt > 0 ? profile.schedulableAccountCount : 0
        }
      : null,
    sessions: profile.lastSessionsSyncAt > 0 ? profile.sessionCount : null
  };
}
