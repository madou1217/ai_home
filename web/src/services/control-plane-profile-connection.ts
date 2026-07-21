import type { ControlPlaneProfile } from '@/types';
import {
  isControlPlaneManagementKeyConfigured,
  normalizeControlPlaneEndpoint,
  saveControlPlaneProfileSecure,
  type ControlPlaneProfileSaveInput
} from './control-plane-profiles';
import {
  authorizeNativeLanProfile,
  isNativeDesktopRuntime
} from './native-server-profile-repository';

interface ControlPlaneConnectionDependencies {
  authorizeLanProfile: typeof authorizeNativeLanProfile;
  isNativeRuntime: typeof isNativeDesktopRuntime;
  saveProfile: typeof saveControlPlaneProfileSecure;
}

const DEFAULT_DEPENDENCIES: ControlPlaneConnectionDependencies = {
  authorizeLanProfile: authorizeNativeLanProfile,
  isNativeRuntime: isNativeDesktopRuntime,
  saveProfile: saveControlPlaneProfileSecure
};

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

export async function connectControlPlaneProfile(
  input: ConnectControlPlaneProfileInput,
  dependencies: ControlPlaneConnectionDependencies = DEFAULT_DEPENDENCIES
) {
  const endpoint = normalizeControlPlaneEndpoint(String(input.endpoint || ''));
  if (!endpoint) throw new Error('请输入有效的 Server 网关地址');
  const profiles = Array.isArray(input.profiles) ? input.profiles : [];
  const profileId = String(input.profileId || '').trim();
  const existing = findConnectionProfile(profiles, profileId, endpoint);
  const managementKey = String(input.managementKey || '').trim();
  if (!managementKey && !isControlPlaneManagementKeyConfigured(existing)) {
    throw new Error('请输入 Management Key');
  }

  const pendingLanAuthorization = Boolean(
    dependencies.isNativeRuntime()
      && existing
      && !existing.managementKeyConfigured
      && existing.authorizationState === 'discovered-pending-auth'
      && existing.routes.some((route) => route.kind === 'direct-lan')
  );
  if (pendingLanAuthorization && existing && managementKey) {
    if (endpoint !== existing.endpoint) {
      throw new Error('待授权 Server 地址已变化，请重新发现');
    }
    // Native re-runs mDNS and verifies the signed LAN endpoint before the Key
    // can enter Keychain. A renderer-supplied endpoint must never bypass proof.
    await dependencies.authorizeLanProfile(existing.id, managementKey);
  }

  const saveInput: ControlPlaneProfileSaveInput = {
    name: String(input.name || '').trim(),
    stableServerId: existing?.stableServerId,
    endpoint,
    routes: existing?.routes,
    activeRouteId: existing?.endpoint === endpoint ? existing.activeRouteId : '',
    authorizationState: pendingLanAuthorization ? 'authorized' : existing?.authorizationState,
    state: 'offline',
    managementKey: pendingLanAuthorization ? '' : managementKey,
    credentialRef: existing?.credentialRef,
    managementKeyConfigured: pendingLanAuthorization
      || Boolean(managementKey)
      || existing?.managementKeyConfigured
  };
  return dependencies.saveProfile(saveInput);
}
