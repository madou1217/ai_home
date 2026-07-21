import type { ControlPlaneProfile } from '@/types';
import { buildAppHref, resolveAppRoutePathname } from './app-navigation';
import { isControlPlaneProfileReady } from './control-plane-profiles';
import {
  resolveStoredActiveControlPlaneProfile,
  type ActiveControlPlaneResolution
} from './control-plane-selection';

export const FABRIC_SERVER_SETUP_PATH = '/server-setup';
export const FABRIC_SERVER_SETUP_TARGET = FABRIC_SERVER_SETUP_PATH;
export const FABRIC_SERVER_SETUP_HREF = buildAppHref(FABRIC_SERVER_SETUP_TARGET);

export interface FabricProfileGateState {
  ready: boolean;
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
  const active = resolveStoredActiveControlPlaneProfile(items, activeProfileId);
  return {
    ready: isControlPlaneProfileReady(active.profile),
    active,
    profileCount: items.length
  };
}

export function shouldRedirectToFabricServerSetup(
  gate: Pick<FabricProfileGateState, 'ready'>,
  pathname: string,
  search = ''
) {
  return !canRenderFabricWorkspace(gate, pathname, search);
}

export function canRenderFabricWorkspace(
  gate: Pick<FabricProfileGateState, 'ready'>,
  pathname: string,
  search = ''
) {
  return gate.ready || isFabricServerSetupLocation(pathname, search);
}
