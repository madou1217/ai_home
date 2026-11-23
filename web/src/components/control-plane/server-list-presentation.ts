import type { ControlPlaneProfile, ControlPlaneProfileState } from '@/types';
import type { SettingStatusState } from '@/components/ui/SettingStatusTag';
import {
  isControlPlaneManagementKeyConfigured,
  isControlPlaneProfileReady
} from '@/services/control-plane-profiles';

/**
 * Server 列表的纯展示映射（桌面 ControlPlaneServerList 与移动端 MobileServers 共用）：
 * 只映射真实的 profile.state 与同步时间戳，不额外发明「在线心跳」。
 */
export type ControlPlaneStatusTone = 'ready' | 'degraded' | 'offline';

/**
 * Server 生命周期标准状态（统一服务于 ServerSetup、Servers、ControlPlaneServerList）：
 * 未连接 → 探测中 → 已探测未保存 → 已保存但未生效 → 当前生效 / 失败
 */
export type ServerLifecycleState =
  | 'disconnected'
  | 'probing'
  | 'probed_unsaved'
  | 'saved_inactive'
  | 'active'
  | 'failed';

export interface ServerLifecycleMeta {
  state: ServerLifecycleState;
  tagStatus: SettingStatusState;
  label: string;
}

export const SERVER_LIFECYCLE_META: Record<ServerLifecycleState, ServerLifecycleMeta> = {
  disconnected: { state: 'disconnected', tagStatus: 'unset', label: '未连接' },
  probing: { state: 'probing', tagStatus: 'saving', label: '探测中' },
  probed_unsaved: { state: 'probed_unsaved', tagStatus: 'dirty', label: '已探测未保存' },
  saved_inactive: { state: 'saved_inactive', tagStatus: 'saved', label: '已保存但未生效' },
  active: { state: 'active', tagStatus: 'applied', label: '当前生效' },
  failed: { state: 'failed', tagStatus: 'error', label: '失败' }
};

export function resolveProfileLifecycle(
  profile: ControlPlaneProfile | null,
  options: { active?: boolean; probing?: boolean; authorizationPending?: boolean } = {}
): ServerLifecycleMeta {
  if (options.probing) return SERVER_LIFECYCLE_META.probing;
  if (!profile) return SERVER_LIFECYCLE_META.disconnected;
  if (options.authorizationPending || !isControlPlaneManagementKeyConfigured(profile)) {
    return {
      state: 'disconnected',
      tagStatus: 'dirty',
      label: '未连接·待授权'
    };
  }
  if (profile.state === 'degraded' || Boolean(profile.lastError)) {
    return SERVER_LIFECYCLE_META.failed;
  }
  if (!isControlPlaneProfileReady(profile)) {
    return SERVER_LIFECYCLE_META.disconnected;
  }
  return options.active ? SERVER_LIFECYCLE_META.active : SERVER_LIFECYCLE_META.saved_inactive;
}

export function formatServerKeyPersistenceLabel(profile: ControlPlaneProfile | null): string {
  if (!profile) return '未保存凭据';
  return isControlPlaneManagementKeyConfigured(profile) ? '已保存 Management Key' : '未配置 Management Key';
}

export const CONTROL_PLANE_PROFILE_STATUS: Record<ControlPlaneProfileState, { tone: ControlPlaneStatusTone; label: string }> = {
  ready: { tone: 'ready', label: '就绪' },
  degraded: { tone: 'degraded', label: '失败' },
  offline: { tone: 'offline', label: '未连接' }
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
