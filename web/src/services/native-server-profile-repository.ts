import { isTauriServerRuntime } from './server-transport/runtime';

export interface NativeServerProfileSummary {
  id: string;
  name: string;
  endpoint: string;
  credentialRef: string;
  managementKeyConfigured: boolean;
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface NativeServerProfileList {
  profiles: NativeServerProfileSummary[];
  activeProfileId: string;
}

export interface NativeServerProfileUpsertInput {
  id?: string;
  name: string;
  endpoint: string;
  managementKey?: string;
  metadata?: Record<string, unknown>;
}

export interface NativeManagementKeyRotateResponse {
  rotated: boolean;
  profile: NativeServerProfileSummary;
}

export interface NativeDiscoveredServerRoute {
  kind: string;
  endpoint: string;
  health?: string;
}

export interface NativeDiscoveredServer {
  stableServerId: string;
  name: string;
  online: boolean;
  capabilities: string[];
  routes: NativeDiscoveredServerRoute[];
}

export interface NativeServerDiscoveryResult {
  ok: boolean;
  servers: NativeDiscoveredServer[];
}

export interface NativeOutboundRelayConfigureResult {
  ok: boolean;
  config?: Record<string, unknown>;
  runtime?: Record<string, unknown>;
}

export interface NativeFrpRouteConfigureResult {
  ok: boolean;
  partial: boolean;
  stableServerId: string;
  provider: { profileId: string; action: string };
  visitors: Array<{
    profileId: string;
    action: string;
    bindPort: number;
    status: 'ready' | 'failed';
    lastError: string;
  }>;
}

export interface NativeRelayRouteTrustResult {
  trusted: boolean;
  routeId: string;
  kind: 'relay-via-server' | 'frp';
}

export interface NativeLanRouteRefreshResult {
  ok: boolean;
  partial: boolean;
  profiles: Array<{
    profileId: string;
    status: 'ready' | 'failed';
    routeCount: number;
    lastError: string;
  }>;
}

export function isNativeDesktopRuntime() {
  return isTauriServerRuntime();
}

async function invokeNative<T>(command: string, input: Record<string, unknown>): Promise<T> {
  if (!isNativeDesktopRuntime()) throw new Error('native_desktop_runtime_unavailable');
  const { invoke } = await import('@tauri-apps/api/tauri');
  try {
    return await invoke<T>(command, { input });
  } catch (error) {
    const source = error && typeof error === 'object'
      ? error as { code?: unknown; message?: unknown; status?: unknown }
      : {};
    const code = String(source.code || 'native_profile_command_failed');
    const message = String(source.message || code);
    const safeMessage = /bearer|authorization|management.?key\s*[:=]|https?:\/\//i.test(message)
      ? code
      : message.slice(0, 512);
    const wrapped = new Error(safeMessage) as Error & { code?: string; status?: number };
    wrapped.code = code;
    const status = Number(source.status);
    if (Number.isInteger(status)) wrapped.status = status;
    throw wrapped;
  }
}

export function listNativeServerProfiles(): Promise<NativeServerProfileList> {
  return invokeNative('desktop_profile_list', {});
}

export function discoverNativeServers(timeoutMs = 1_500): Promise<NativeServerDiscoveryResult> {
  const boundedTimeoutMs = Math.max(250, Math.min(10_000, Math.floor(Number(timeoutMs) || 1_500)));
  return invokeNative('desktop_discover_servers', { timeoutMs: boundedTimeoutMs });
}

export function configureNativeOutboundRelays(
  localProfileId: string,
  relayProfileIds: string[]
): Promise<NativeOutboundRelayConfigureResult> {
  return invokeNative('desktop_outbound_relays_configure', {
    localProfileId,
    relayProfileIds
  });
}

export function configureNativeFrpRoute(
  providerProfileId: string,
  visitorProfileIds: string[]
): Promise<NativeFrpRouteConfigureResult> {
  return invokeNative('desktop_frp_route_configure', {
    providerProfileId,
    visitorProfileIds
  });
}

export function trustNativeRelayRoute(
  sourceProfileId: string,
  targetProfileId: string,
  targetStableServerId: string
): Promise<NativeRelayRouteTrustResult> {
  return invokeNative('desktop_relay_route_trust', {
    sourceProfileId,
    targetProfileId,
    targetStableServerId
  });
}

export async function authorizeNativeLanProfile(
  profileId: string,
  managementKey: string,
  timeoutMs = 1_500
): Promise<NativeServerProfileSummary> {
  const result = await invokeNative<{ profile: NativeServerProfileSummary }>(
    'desktop_lan_profile_authorize',
    {
      profileId,
      managementKey,
      timeoutMs: Math.max(250, Math.min(10_000, Math.floor(Number(timeoutMs) || 1_500)))
    }
  );
  return result.profile;
}

export function refreshNativeLanRoutes(
  profileIds: string[],
  timeoutMs = 1_500
): Promise<NativeLanRouteRefreshResult> {
  return invokeNative('desktop_lan_routes_refresh', {
    profileIds: Array.from(new Set(profileIds.map((value) => String(value || '').trim()).filter(Boolean))),
    timeoutMs: Math.max(250, Math.min(10_000, Math.floor(Number(timeoutMs) || 1_500)))
  });
}

export async function upsertNativeServerProfile(
  input: NativeServerProfileUpsertInput
): Promise<NativeServerProfileSummary> {
  const result = await invokeNative<{ profile: NativeServerProfileSummary }>(
    'desktop_profile_upsert',
    input as unknown as Record<string, unknown>
  );
  return result.profile;
}

export function rotateNativeServerManagementKey(
  profileId: string,
  managementKey: string
): Promise<NativeManagementKeyRotateResponse> {
  return invokeNative<NativeManagementKeyRotateResponse>(
    'desktop_management_key_rotate',
    { profileId, managementKey }
  );
}

export async function removeNativeServerProfile(profileId: string) {
  return invokeNative<{ removed: boolean; activeProfileId: string }>(
    'desktop_profile_remove',
    { profileId }
  );
}

export async function setActiveNativeServerProfile(profileId: string) {
  return invokeNative<{
    activeProfileId: string;
    profile: NativeServerProfileSummary | null;
  }>('desktop_profile_set_active', { profileId });
}

export async function getActiveNativeServerProfile() {
  return invokeNative<{ profile: NativeServerProfileSummary | null }>(
    'desktop_profile_get_active',
    {}
  );
}
