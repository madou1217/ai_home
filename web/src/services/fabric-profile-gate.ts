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

export const FABRIC_SERVER_SETUP_PATH = '/server-setup';
export const FABRIC_SERVER_SETUP_TARGET = FABRIC_SERVER_SETUP_PATH;
export const FABRIC_SERVER_SETUP_HREF = buildAppHref(FABRIC_SERVER_SETUP_TARGET);

export interface FabricProfileGateState {
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

export function isFabricServerSetupPath(pathname: string) {
  return resolveAppRoutePathname(pathname) === FABRIC_SERVER_SETUP_PATH;
}

export function isFabricServerSetupLocation(pathname: string, _search = '') {
  return isFabricServerSetupPath(pathname);
}

export function resolveFabricServerSetupTarget(_search = '') {
  return FABRIC_SERVER_SETUP_TARGET;
}

export function resolveFabricProfileGateState(
  profiles: ControlPlaneProfile[],
  activeProfileId = ''
): FabricProfileGateState {
  const items = Array.isArray(profiles) ? profiles : [];
  const active = resolveCurrentControlPlaneProfile(items, activeProfileId);
  return {
    ready: isControlPlaneProfileReady(active.profile),
    configured: isControlPlaneManagementKeyConfigured(active.profile),
    active,
    profileCount: items.length
  };
}

export function shouldRedirectToFabricServerSetup(
  gate: Pick<FabricProfileGateState, 'ready' | 'configured'>,
  pathname: string,
  search = ''
) {
  return !canRenderFabricWorkspace(gate, pathname, search);
}

export function canRenderFabricWorkspace(
  gate: Pick<FabricProfileGateState, 'ready' | 'configured'>,
  pathname: string,
  search = ''
) {
  return gate.ready || gate.configured || isFabricServerSetupLocation(pathname, search);
}
