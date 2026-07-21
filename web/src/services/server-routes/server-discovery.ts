import type { ServerAuthorizationState, ServerRoute } from '@/types';
import { normalizeControlPlaneEndpoint } from '../control-plane-api-client';
import {
  mergeServerRoutes,
  normalizeServerRoute,
  normalizeStableServerId
} from './server-route-normalizer';

function normalizeText(value: unknown, maxLength = 512) {
  const text = String(value ?? '').trim();
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function resolveDiscoveredRouteEndpoint(value: unknown, sourceEndpoint: string) {
  const route = value && typeof value === 'object'
    ? value as Record<string, unknown>
    : null;
  if (!route || route.endpoint) return value;

  const path = String(route.path ?? '');
  if (
    !path
    || path !== path.trim()
    || path.length > 2048
    || !path.startsWith('/')
    || path.startsWith('//')
    || path.includes('\\')
    || path.includes('#')
  ) {
    return value;
  }

  const endpoint = normalizeControlPlaneEndpoint(sourceEndpoint);
  if (!endpoint) return value;

  try {
    const relative = new URL(path, 'https://aih-route.invalid');
    if (
      relative.origin !== 'https://aih-route.invalid'
      || (relative.pathname !== '/v0' && !relative.pathname.startsWith('/v0/'))
    ) {
      return value;
    }
    const resolved = new URL(endpoint);
    const basePath = resolved.pathname.replace(/\/+$/, '');
    resolved.pathname = `${basePath}${relative.pathname}`;
    resolved.search = relative.search;
    resolved.hash = '';
    return { ...route, endpoint: resolved.toString() };
  } catch (_error) {
    return value;
  }
}

export interface ServerDiscoverySource {
  stableServerId: string;
  endpoint: string;
}

export interface ServerDiscoveryRecord {
  stableServerId?: string;
  /** Compatibility input for broker registries that have not renamed serverId yet. */
  serverId?: string;
  name?: string;
  routes?: unknown[];
  online?: boolean;
}

export interface ServerDiscoveryResponse {
  ok?: boolean;
  rpc?: string;
  servers?: ServerDiscoveryRecord[];
  result?: {
    servers?: ServerDiscoveryRecord[];
  };
}

export interface DiscoveredLogicalServer {
  stableServerId: string;
  name: string;
  managementKey: string;
  credentialRef: string;
  managementKeyConfigured: boolean;
  authorizationState: ServerAuthorizationState;
  routes: ServerRoute[];
}

export interface ServerDiscoveryFailure {
  source: ServerDiscoverySource;
  error: string;
}

function normalizeExistingServer(value: unknown): DiscoveredLogicalServer | null {
  const source = value && typeof value === 'object'
    ? value as Partial<DiscoveredLogicalServer>
    : null;
  if (!source) return null;
  const stableServerId = normalizeStableServerId(source.stableServerId);
  if (!stableServerId) return null;
  const managementKey = normalizeText(source.managementKey, 4096);
  const managementKeyConfigured = Boolean(source.managementKeyConfigured || managementKey);
  return {
    stableServerId,
    name: normalizeText(source.name, 120) || stableServerId,
    managementKey,
    credentialRef: normalizeText(source.credentialRef, 256),
    managementKeyConfigured,
    authorizationState: managementKeyConfigured ? 'authorized' : 'discovered-pending-auth',
    routes: mergeServerRoutes(source.routes)
  };
}

export function mergeServerDiscoveryResponses(
  existingServers: unknown[],
  discovered: Array<{ source: ServerDiscoverySource; response: ServerDiscoveryResponse }>
): DiscoveredLogicalServer[] {
  const byStableId = new Map<string, DiscoveredLogicalServer>();
  existingServers.forEach((value) => {
    const server = normalizeExistingServer(value);
    if (server) byStableId.set(server.stableServerId, server);
  });
  discovered.forEach(({ source, response }) => {
    const viaServerId = normalizeStableServerId(source.stableServerId);
    const responseServers = Array.isArray(response?.result?.servers)
      ? response.result.servers
      : (Array.isArray(response?.servers) ? response.servers : []);
    responseServers.forEach((record) => {
      const stableServerId = normalizeStableServerId(record?.stableServerId || record?.serverId);
      if (!stableServerId) return;
      const existing = byStableId.get(stableServerId) || {
        stableServerId,
        name: normalizeText(record?.name, 120) || stableServerId,
        managementKey: '',
        credentialRef: '',
        managementKeyConfigured: false,
        authorizationState: 'discovered-pending-auth' as const,
        routes: []
      };
      const discoveredRoutes = (Array.isArray(record?.routes) ? record.routes : [])
        .map((route) => normalizeServerRoute(resolveDiscoveredRouteEndpoint(route, source.endpoint), {
          kind: 'relay-via-server',
          viaServerId,
          health: record.online === true ? 'healthy'
            : record.online === false ? 'offline'
              : 'unknown'
        }))
        .filter((route): route is ServerRoute => Boolean(route));
      byStableId.set(stableServerId, {
        ...existing,
        name: existing.name || normalizeText(record?.name, 120) || stableServerId,
        authorizationState: existing.managementKeyConfigured
          ? 'authorized'
          : 'discovered-pending-auth',
        routes: mergeServerRoutes(existing.routes, discoveredRoutes)
      });
    });
  });
  return Array.from(byStableId.values())
    .sort((left, right) => left.name.localeCompare(right.name) || left.stableServerId.localeCompare(right.stableServerId));
}

function safeDiscoveryError(value: unknown) {
  const message = normalizeText(value instanceof Error ? value.message : value, 256);
  if (/bearer|authorization|management.?key\s*[:=]|https?:\/\//i.test(message)) {
    return 'server_discovery_failed';
  }
  return message || 'server_discovery_failed';
}

export async function discoverServersAcrossRelays(input: {
  sources: ServerDiscoverySource[];
  existingServers?: unknown[];
  discover: (source: ServerDiscoverySource) => Promise<ServerDiscoveryResponse>;
}): Promise<{ servers: DiscoveredLogicalServer[]; failures: ServerDiscoveryFailure[] }> {
  const sources = (Array.isArray(input.sources) ? input.sources : [])
    .map((source) => ({
      stableServerId: normalizeStableServerId(source?.stableServerId),
      endpoint: normalizeControlPlaneEndpoint(String(source?.endpoint || ''))
    }))
    .filter((source) => source.stableServerId && source.endpoint);
  const settled = await Promise.allSettled(sources.map(async (source) => ({
    source,
    response: await input.discover(source)
  })));
  const discovered: Array<{ source: ServerDiscoverySource; response: ServerDiscoveryResponse }> = [];
  const failures: ServerDiscoveryFailure[] = [];
  settled.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      discovered.push(result.value);
      return;
    }
    failures.push({
      source: sources[index],
      error: safeDiscoveryError(result.reason)
    });
  });
  return {
    servers: mergeServerDiscoveryResponses(input.existingServers || [], discovered),
    failures
  };
}

export interface LanServerDiscoveryResponse {
  ok?: boolean;
  servers?: ServerDiscoveryRecord[];
}

function sanitizeLanDiscoveryResponse(response: LanServerDiscoveryResponse): ServerDiscoveryResponse {
  const servers = (Array.isArray(response?.servers) ? response.servers : []).map((record) => ({
    ...record,
    routes: (Array.isArray(record?.routes) ? record.routes : []).map((value) => {
      const route = value && typeof value === 'object'
        ? value as Record<string, unknown>
        : {};
      return {
        ...route,
        kind: 'direct-lan',
        viaServerId: ''
      };
    })
  }));
  return { servers };
}

export async function discoverServersOnLan(input: {
  existingServers?: unknown[];
  discover: () => Promise<LanServerDiscoveryResponse>;
}): Promise<{ servers: DiscoveredLogicalServer[]; error: string }> {
  try {
    const response = sanitizeLanDiscoveryResponse(await input.discover());
    return {
      servers: mergeServerDiscoveryResponses(input.existingServers || [], [{
        source: { stableServerId: '', endpoint: '' },
        response
      }]),
      error: ''
    };
  } catch (error) {
    return {
      servers: mergeServerDiscoveryResponses(input.existingServers || [], []),
      error: safeDiscoveryError(error)
    };
  }
}
