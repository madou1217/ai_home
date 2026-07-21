import type { ServerRoute, ServerRouteHealth, ServerRouteKind } from '@/types';
import { normalizeControlPlaneEndpoint } from '../control-plane-api-client';

const ROUTE_KINDS: ServerRouteKind[] = ['direct', 'direct-lan', 'relay-via-server', 'frp'];
const ROUTE_HEALTH_STATES: ServerRouteHealth[] = ['healthy', 'degraded', 'offline', 'unknown'];

function normalizeText(value: unknown, maxLength = 512) {
  const text = String(value ?? '').trim();
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function stableHash(value: string) {
  let hash = 2166136261;
  for (const char of value) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export type DirectServerEndpointScope = 'loopback' | 'lan' | 'other';

function ipv4Octets(hostname: string) {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(hostname)) return null;
  const octets = hostname.split('.').map(Number);
  return octets.every((value) => Number.isInteger(value) && value >= 0 && value <= 255)
    ? octets
    : null;
}

export function classifyDirectServerEndpoint(value: unknown): DirectServerEndpointScope {
  try {
    const parsed = new URL(normalizeControlPlaneEndpoint(String(value || '')));
    const hostname = parsed.hostname.replace(/^\[|\]$/gu, '').toLowerCase();
    if (hostname === 'localhost' || hostname === '::1') return 'loopback';
    const octets = ipv4Octets(hostname);
    if (octets) {
      if (octets[0] === 127) return 'loopback';
      if (
        octets[0] === 10
        || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
        || (octets[0] === 192 && octets[1] === 168)
        || (octets[0] === 169 && octets[1] === 254)
      ) return 'lan';
      return 'other';
    }
    if (hostname.endsWith('.local')) return 'lan';
    if (hostname.includes(':') && /^(?:fc|fd|fe[89ab])/u.test(hostname)) return 'lan';
    return 'other';
  } catch (_error) {
    return 'other';
  }
}

export function normalizeStableServerId(value: unknown, fallbackSeed = ''): string {
  const candidate = String(value ?? '');
  if (candidate) {
    return /^[a-z0-9][a-z0-9_.-]{1,63}$/u.test(candidate) ? candidate : '';
  }
  const seed = normalizeText(fallbackSeed, 2048);
  return seed ? `server-${stableHash(seed)}` : '';
}

function normalizeRouteKind(value: unknown): ServerRouteKind | '' {
  const raw = normalizeText(value, 32).toLowerCase();
  const kind = (
    raw === 'relay' ? 'relay-via-server'
      : raw
  ) as ServerRouteKind;
  return ROUTE_KINDS.includes(kind) ? kind : '';
}

function normalizeRouteHealth(value: unknown): ServerRouteHealth {
  const health = normalizeText(value, 32).toLowerCase() as ServerRouteHealth;
  return ROUTE_HEALTH_STATES.includes(health) ? health : 'unknown';
}

function normalizeTimestamp(value: unknown) {
  return Math.max(0, Number(value) || 0);
}

function normalizeFailureRate(value: unknown) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function routeIdentity(route: Pick<ServerRoute, 'kind' | 'endpoint'>) {
  return `${route.kind}|${route.endpoint}`;
}

export function normalizeServerRoute(
  value: unknown,
  defaults: Partial<Pick<ServerRoute, 'kind' | 'viaServerId' | 'health'>> = {}
): ServerRoute | null {
  const source = value && typeof value === 'object'
    ? value as Partial<ServerRoute>
    : null;
  if (!source) return null;
  const endpoint = normalizeControlPlaneEndpoint(String(source.endpoint || ''));
  const requestedKind = normalizeRouteKind(source.kind || defaults.kind);
  const kind = requestedKind === 'direct-lan'
    && classifyDirectServerEndpoint(endpoint) !== 'lan'
    ? 'direct'
    : requestedKind;
  if (!endpoint || !kind) return null;
  const viaServerId = normalizeStableServerId(source.viaServerId || defaults.viaServerId);
  const identity = `${kind}|${endpoint}|${viaServerId}`;
  return {
    id: normalizeText(source.id, 128) || `route-${stableHash(identity)}`,
    kind,
    endpoint,
    viaServerId,
    health: normalizeRouteHealth(source.health || defaults.health),
    rttMs: Math.max(0, Number(source.rttMs) || 0),
    failureRate: normalizeFailureRate(source.failureRate),
    consecutiveFailures: Math.max(0, Math.floor(Number(source.consecutiveFailures) || 0)),
    lastCheckedAt: normalizeTimestamp(source.lastCheckedAt),
    lastSuccessAt: normalizeTimestamp(source.lastSuccessAt),
    lastFailureAt: normalizeTimestamp(source.lastFailureAt),
    updatedAt: normalizeTimestamp(source.updatedAt)
  };
}

export function mergeServerRoutes(...routeGroups: unknown[]): ServerRoute[] {
  const merged: ServerRoute[] = [];
  const byId = new Map<string, number>();
  const byIdentity = new Map<string, number>();
  routeGroups.flatMap((group) => Array.isArray(group) ? group : []).forEach((value) => {
    const route = normalizeServerRoute(value);
    if (!route) return;
    const identity = routeIdentity(route);
    const existingIndex = byId.get(route.id) ?? byIdentity.get(identity);
    if (existingIndex === undefined) {
      const nextIndex = merged.length;
      merged.push(route);
      byId.set(route.id, nextIndex);
      byIdentity.set(identity, nextIndex);
      return;
    }
    const existing = merged[existingIndex];
    const next = {
      ...existing,
      ...route,
      id: existing.id,
      viaServerId: route.viaServerId || existing.viaServerId,
      health: route.health === 'unknown' ? existing.health : route.health,
      rttMs: route.rttMs || existing.rttMs,
      lastCheckedAt: Math.max(existing.lastCheckedAt, route.lastCheckedAt),
      lastSuccessAt: Math.max(existing.lastSuccessAt, route.lastSuccessAt),
      lastFailureAt: Math.max(existing.lastFailureAt, route.lastFailureAt),
      updatedAt: Math.max(existing.updatedAt, route.updatedAt)
    };
    merged[existingIndex] = next;
    byId.set(next.id, existingIndex);
    byIdentity.set(routeIdentity(next), existingIndex);
  });
  return merged.sort((left, right) => left.id.localeCompare(right.id));
}

export interface LegacyServerRouteInput {
  endpoint?: unknown;
  connectionMode?: unknown;
  broker?: {
    brokerEndpoint?: unknown;
    serverId?: unknown;
    proxyEndpoint?: unknown;
  } | null;
  state?: unknown;
  routes?: unknown;
}

function legacyStateToHealth(value: unknown): ServerRouteHealth {
  const state = normalizeText(value, 32).toLowerCase();
  if (state === 'ready') return 'healthy';
  if (state === 'degraded') return 'degraded';
  if (state === 'offline') return 'offline';
  return 'unknown';
}

export function migrateLegacyServerRoutes(input: LegacyServerRouteInput): ServerRoute[] {
  const current = Array.isArray(input.routes) ? input.routes : [];
  const normalizedCurrent = mergeServerRoutes(current);
  const endpoint = normalizeControlPlaneEndpoint(String(
    input.endpoint || input.broker?.proxyEndpoint || ''
  ));
  if (!endpoint || normalizedCurrent.some((route) => route.endpoint === endpoint)) {
    return normalizedCurrent;
  }
  const brokerMode = normalizeText(input.connectionMode, 32).toLowerCase() === 'broker-proxy'
    || Boolean(input.broker);
  const legacyRoute = normalizeServerRoute({
    kind: brokerMode ? 'relay-via-server' : 'direct',
    endpoint,
    health: legacyStateToHealth(input.state)
  });
  return mergeServerRoutes(normalizedCurrent, legacyRoute ? [legacyRoute] : []);
}
