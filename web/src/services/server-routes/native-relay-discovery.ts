import type {
  ControlPlaneProfile,
  ServerAuthorizationState
} from '@/types';
import {
  listControlPlaneProfiles,
  saveControlPlaneProfileSecure,
  type ControlPlaneProfileSaveInput
} from '../control-plane-profiles';
import { trustNativeRelayRoute } from '../native-server-profile-repository';
import { requestNativeServerJson } from '../native-server-transport';
import {
  discoverServersAcrossRelays,
  normalizeStableServerId,
  type DiscoveredLogicalServer,
  type ServerDiscoveryFailure,
  type ServerDiscoveryResponse
} from './server-route-service';

const RELAY_DIRECTORY_PATH = '/v0/fabric/broker/servers';
const DEFAULT_RELAY_DISCOVERY_TIMEOUT_MS = 2_500;
const MIN_RELAY_DISCOVERY_TIMEOUT_MS = 1_000;
const MAX_RELAY_DISCOVERY_TIMEOUT_MS = 10_000;

export interface NativeRelayDiscoveryOptions {
  profiles?: ControlPlaneProfile[];
  timeoutMs?: number;
}

export interface NativeRelayDiscoveryResult {
  servers: DiscoveredLogicalServer[];
  failures: ServerDiscoveryFailure[];
  queried: number;
  saved: number;
  trusted: number;
}

interface RelayTrustRequest {
  sourceProfile: ControlPlaneProfile;
  targetProfile: ControlPlaneProfile;
  targetStableServerId: string;
}

type RelayProfileSaveInput = ControlPlaneProfileSaveInput & { endpoint: string };

function boundedTimeoutMs(value: unknown) {
  const requested = Math.floor(Number(value) || DEFAULT_RELAY_DISCOVERY_TIMEOUT_MS);
  return Math.max(
    MIN_RELAY_DISCOVERY_TIMEOUT_MS,
    Math.min(MAX_RELAY_DISCOVERY_TIMEOUT_MS, requested)
  );
}

function isAuthorizedProfile(profile: ControlPlaneProfile) {
  return Boolean(
    String(profile.id || '').trim()
      && normalizeStableServerId(profile.stableServerId)
      && String(profile.endpoint || '').trim()
      && profile.managementKeyConfigured
      && profile.authorizationState === 'authorized'
  );
}

function responseServers(response: ServerDiscoveryResponse) {
  if (Array.isArray(response?.result?.servers)) return response.result.servers;
  return Array.isArray(response?.servers) ? response.servers : [];
}

async function requestRelayDirectory(profileId: string, timeoutMs: number) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error('relay_directory_timeout'));
      controller.abort();
    }, timeoutMs);
  });

  try {
    const response = await Promise.race([
      requestNativeServerJson<ServerDiscoveryResponse>({
        profileId,
        method: 'GET',
        path: RELAY_DIRECTORY_PATH,
        accept: 'application/json',
        timeoutMs,
        signal: controller.signal
      }),
      timeout
    ]);
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`relay_directory_http_${response.status}`);
    }
    return response.data;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function profileSaveInput(
  server: DiscoveredLogicalServer,
  existing: ControlPlaneProfile | null
): RelayProfileSaveInput | null {
  const activeRoute = server.routes.find((route) => route.id === existing?.activeRouteId)
    || server.routes.find((route) => route.endpoint === existing?.endpoint)
    || server.routes[0]
    || null;
  const endpoint = activeRoute?.endpoint || existing?.endpoint || '';
  if (!endpoint) return null;
  const managementKeyConfigured = Boolean(
    existing?.managementKeyConfigured || server.managementKeyConfigured
  );
  const authorizationState: ServerAuthorizationState = managementKeyConfigured
    ? 'authorized'
    : 'discovered-pending-auth';
  return {
    stableServerId: server.stableServerId,
    name: existing?.name || server.name,
    endpoint,
    routes: server.routes,
    activeRouteId: activeRoute?.id || '',
    authorizationState,
    state: existing?.state || (managementKeyConfigured ? 'ready' : 'offline'),
    credentialRef: existing?.credentialRef || server.credentialRef,
    managementKeyConfigured
  };
}

/**
 * Queries every authorized Desktop profile as an independent relay directory.
 * Native transport resolves the Management Key from Keychain by profileId.
 */
export async function discoverNativeServersAcrossRelays(
  options: NativeRelayDiscoveryOptions = {}
): Promise<NativeRelayDiscoveryResult> {
  const profiles = Array.isArray(options.profiles)
    ? options.profiles
    : listControlPlaneProfiles();
  const authorizedProfiles = profiles.filter(isAuthorizedProfile);
  const profileByStableServerId = new Map(
    authorizedProfiles.map((profile) => [
      normalizeStableServerId(profile.stableServerId),
      profile
    ])
  );
  const authorizedProfileById = new Map(
    authorizedProfiles.map((profile) => [profile.id, profile])
  );
  const existingByStableServerId = new Map(
    profiles.map((profile) => [profile.stableServerId, profile])
  );
  const discoveredStableServerIds = new Set<string>();
  const sourceProfileIdsByTarget = new Map<string, Set<string>>();
  const timeoutMs = boundedTimeoutMs(options.timeoutMs);
  const discovery = await discoverServersAcrossRelays({
    sources: authorizedProfiles.map((profile) => ({
      stableServerId: profile.stableServerId,
      endpoint: profile.endpoint
    })),
    existingServers: profiles,
    discover: async (source) => {
      const profile = profileByStableServerId.get(source.stableServerId);
      if (!profile) throw new Error('relay_source_profile_missing');
      const response = await requestRelayDirectory(profile.id, timeoutMs);
      responseServers(response).forEach((server) => {
        const stableServerId = normalizeStableServerId(
          server?.stableServerId || server?.serverId
        );
        if (!stableServerId) return;
        discoveredStableServerIds.add(stableServerId);
        const sourceProfileIds = sourceProfileIdsByTarget.get(stableServerId)
          || new Set<string>();
        sourceProfileIds.add(profile.id);
        sourceProfileIdsByTarget.set(stableServerId, sourceProfileIds);
      });
      return response;
    }
  });

  let saved = 0;
  const failures = discovery.failures.slice();
  const trustRequests: RelayTrustRequest[] = [];
  for (const server of discovery.servers) {
    if (!discoveredStableServerIds.has(server.stableServerId)) continue;
    const input = profileSaveInput(
      server,
      existingByStableServerId.get(server.stableServerId) || null
    );
    if (!input) continue;
    try {
      await saveControlPlaneProfileSecure(input);
      saved += 1;
      const targetProfile = existingByStableServerId.get(server.stableServerId) || null;
      if (
        targetProfile?.managementKeyConfigured
        && targetProfile.authorizationState === 'authorized'
      ) {
        const sourceProfileIds = sourceProfileIdsByTarget.get(server.stableServerId)
          || new Set<string>();
        sourceProfileIds.forEach((sourceProfileId) => {
          if (sourceProfileId === targetProfile.id) return;
          const sourceProfile = authorizedProfileById.get(sourceProfileId);
          if (!sourceProfile) return;
          trustRequests.push({
            sourceProfile,
            targetProfile,
            targetStableServerId: server.stableServerId
          });
        });
      }
    } catch (_error) {
      failures.push({
        source: {
          stableServerId: server.stableServerId,
          endpoint: input.endpoint
        },
        error: 'server_profile_persist_failed'
      });
    }
  }

  const trustResults = await Promise.allSettled(trustRequests.map((request) => (
    trustNativeRelayRoute(
      request.sourceProfile.id,
      request.targetProfile.id,
      request.targetStableServerId
    )
  )));
  let trusted = 0;
  trustResults.forEach((result, index) => {
    if (result.status === 'fulfilled' && result.value.trusted) {
      trusted += 1;
      return;
    }
    const request = trustRequests[index];
    failures.push({
      source: {
        stableServerId: request.sourceProfile.stableServerId,
        endpoint: request.sourceProfile.endpoint
      },
      error: 'relay_route_trust_failed'
    });
  });

  return {
    servers: discovery.servers,
    failures,
    queried: authorizedProfiles.length,
    saved,
    trusted
  };
}

/** Fire-and-forget startup hook: discovery can never delay or reject app bootstrap. */
export function startNativeRelayDiscovery(options: NativeRelayDiscoveryOptions = {}) {
  void discoverNativeServersAcrossRelays(options).catch(() => {});
}
