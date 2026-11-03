import type { ControlPlaneProfile } from '@/types';
import { buildAppHref, resolveAppRoutePathname } from './app-navigation';
import {
  isControlPlaneManagementKeyConfigured,
  isControlPlaneProfileReady
} from './control-plane-profiles';
import {
  resolveCurrentControlPlaneProfile,
  type ActiveControlPlaneResolution
} from './control-plane-selection';

export const SERVER_SETUP_PATH = '/server-setup';
export const SERVER_SETUP_TARGET = SERVER_SETUP_PATH;
export const SERVER_SETUP_HREF = buildAppHref(SERVER_SETUP_TARGET);

export interface ServerProfileGateState {
  ready: boolean;
  /**
   * 当前 profile 已配置 Management Key（setup 完成）。
   * profile.state 是异步刷写出的运行期健康快照，冷启动时可能是上一轮
   * 遗留的 degraded/offline；gate 只能依据配置完整性判定，否则会把
   * 已完成 setup 的客户端误踢回 /server-setup。Key 真正失效时由数据面
   * 401/503 webui_unauthorized 拦截器负责引导（见 services/api.ts）。
   */
  configured: boolean;
  active: ActiveControlPlaneResolution;
  profileCount: number;
}

export function isServerSetupPath(pathname: string) {
  return resolveAppRoutePathname(pathname) === SERVER_SETUP_PATH;
}

export function isServerSetupLocation(pathname: string, _search = '') {
  return isServerSetupPath(pathname);
}

export function resolveServerSetupTarget(_search = '') {
  return SERVER_SETUP_TARGET;
}

export function resolveServerProfileGateState(
  profiles: ControlPlaneProfile[],
  activeProfileId = ''
): ServerProfileGateState {
  const items = Array.isArray(profiles) ? profiles : [];
  const active = resolveCurrentControlPlaneProfile(items, activeProfileId);
  return {
    ready: isControlPlaneProfileReady(active.profile),
    configured: isControlPlaneManagementKeyConfigured(active.profile),
    active,
    profileCount: items.length
  };
}

export function shouldRedirectToServerSetup(
  gate: Pick<ServerProfileGateState, 'ready' | 'configured'>,
  pathname: string,
  search = ''
) {
  return !canRenderWorkspace(gate, pathname, search);
}

export function canRenderWorkspace(
  gate: Pick<ServerProfileGateState, 'ready' | 'configured'>,
  pathname: string,
  search = ''
) {
  return gate.ready || gate.configured || isServerSetupLocation(pathname, search);
}
