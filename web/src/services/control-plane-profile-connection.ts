import type { ControlPlaneProfile } from '@/types';
import {
  isControlPlaneManagementKeyConfigured,
  fetchControlPlaneDeviceStatus,
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

  // Verify a replacement before persisting it. A mistyped/scanned stale key
  // must not overwrite a working credential and leave the client locked out.
  if (managementKey) {
    await fetchControlPlaneDeviceStatus({ endpoint, managementKey });
  }

  // 编辑已保存的 server 时，managementKey 留空表示「不改动」——
  // 直接传空串会把已存的 key 清掉，等于把这条 server 弄废。
  // 上面的校验已保证：留空只在 existing 已配置 key 时允许。
  const saveInput: ControlPlaneProfileSaveInput = {
    name: String(input.name || '').trim(),
    stableServerId: existing?.stableServerId,
    endpoint,
    routes: existing?.routes,
    activeRouteId: existing?.endpoint === endpoint ? existing.activeRouteId : '',
    authorizationState: existing?.authorizationState,
    state: 'offline',
    ...(managementKey ? { managementKey } : {}),
    managementKeyConfigured: Boolean(managementKey) || existing?.managementKeyConfigured
  };
  return saveControlPlaneProfile(saveInput);
}
