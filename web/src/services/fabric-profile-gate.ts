import type { ControlPlaneProfile } from '@/types';
import { isControlPlaneProfileReady } from './control-plane-profiles';
import {
  resolveStoredActiveControlPlaneProfile,
  type ActiveControlPlaneResolution
} from './control-plane-selection';

export const FABRIC_SERVER_SETUP_PATH = '/server-setup';
export const FABRIC_SERVER_SETUP_SEARCH = '';
export const FABRIC_SERVER_SETUP_TARGET = `${FABRIC_SERVER_SETUP_PATH}${FABRIC_SERVER_SETUP_SEARCH}`;
export const FABRIC_SERVER_SETUP_HREF = `/ui${FABRIC_SERVER_SETUP_TARGET}`;

export interface FabricProfileGateState {
  ready: boolean;
  active: ActiveControlPlaneResolution;
  profileCount: number;
}

export function isFabricServerSetupPath(pathname: string) {
  return String(pathname || '').trim() === FABRIC_SERVER_SETUP_PATH;
}

function hasPairIntent(search: string) {
  const params = new URLSearchParams(String(search || '').replace(/^\?/, ''));
  return Boolean(
    params.get('pair')
      || params.get('pair_url')
      || params.get('pairUrl')
      || params.get('url')
      || params.get('code')
  );
}

export function isFabricServerSetupLocation(pathname: string, search = '') {
  if (!isFabricServerSetupPath(pathname)) return false;
  return search === '' || hasPairIntent(search);
}

export function resolveFabricServerSetupTarget(search = '') {
  return hasPairIntent(search) ? `${FABRIC_SERVER_SETUP_PATH}${search}` : FABRIC_SERVER_SETUP_TARGET;
}

function normalizePathname(pathname: string) {
  const value = String(pathname || '').trim();
  return value || '/';
}

export function isFabricRoute(pathname: string) {
  const path = normalizePathname(pathname);
  return path === '/fabric' || path.startsWith('/fabric/');
}

export function isFabricProfileProtectedPath(pathname: string) {
  const path = normalizePathname(pathname);
  if (!isFabricRoute(path)) return false;
  if (path === '/fabric') return false;
  if (path === '/fabric/control-planes') return false;
  if (path === '/fabric/remote-nodes') return false;
  if (path === '/fabric/ssh-hosts') return false;
  if (path === '/fabric/nodes') return false;
  if (path === '/fabric/webrtc-diagnostics') return false;
  return true;
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
  return !gate.ready
    && isFabricProfileProtectedPath(pathname)
    && !isFabricServerSetupLocation(pathname, search);
}
