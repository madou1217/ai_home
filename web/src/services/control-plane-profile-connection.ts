import type { ControlPlaneProfile } from '@/types';
import {
  isControlPlaneManagementKeyConfigured,
  normalizeControlPlaneEndpoint,
  saveControlPlaneProfile,
  type ControlPlaneProfileSaveInput
} from './control-plane-profiles';

export interface ConnectControlPlaneProfileInput {
  profiles: ControlPlaneProfile[];
  profileId?: string;
  endpoint?: string;
  name?: string;
  managementKey?: string;
}

function findConnectionProfile(
  profiles: ControlPlaneProfile[],
  profileId: string,
  endpoint: string
) {
  return profiles.find((profile) => profile.id === profileId)
    || profiles.find((profile) => (
      profile.endpoint === endpoint
      || profile.routes.some((route) => route.endpoint === endpoint)
    ))
    || null;
}

export async function connectControlPlaneProfile(input: ConnectControlPlaneProfileInput) {
  const endpoint = normalizeControlPlaneEndpoint(String(input.endpoint || ''));
  if (!endpoint) throw new Error('请输入有效的 Server 网关地址');
  const profiles = Array.isArray(input.profiles) ? input.profiles : [];
  const profileId = String(input.profileId || '').trim();
  const existing = findConnectionProfile(profiles, profileId, endpoint);
  const managementKey = String(input.managementKey || '').trim();
  if (!managementKey && !isControlPlaneManagementKeyConfigured(existing)) {
    throw new Error('请输入 Management Key');
  }

  const saveInput: ControlPlaneProfileSaveInput = {
    name: String(input.name || '').trim(),
    stableServerId: existing?.stableServerId,
    endpoint,
    routes: existing?.routes,
    activeRouteId: existing?.endpoint === endpoint ? existing.activeRouteId : '',
    authorizationState: existing?.authorizationState,
    state: 'offline',
    managementKey,
    credentialRef: existing?.credentialRef,
    managementKeyConfigured: Boolean(managementKey) || existing?.managementKeyConfigured
  };
  return saveControlPlaneProfile(saveInput);
}
