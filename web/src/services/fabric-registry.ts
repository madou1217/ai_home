import type { ControlPlaneProfile } from '@/types';
import { createControlPlaneApiClient } from './control-plane-api-client';
import {
  markActiveControlPlaneProfileDegraded,
  requireActiveControlPlaneProfile,
  resolveStoredActiveControlPlaneContext
} from './active-control-plane';

export interface FabricRegistryCounts {
  nodes: number;
  relayNodes: number;
  transports: number;
  projects: number;
  runtimes: number;
}

export interface FabricRegistryNode {
  id: string;
  name: string;
  roles: string[];
  platform: string;
  arch: string;
  ownerDeviceId: string;
  capabilities: string[];
  status: string;
  tags: string[];
  lastSeenAt: number;
  updatedAt: number;
}

export interface FabricRegistryRelayNode {
  id: string;
  nodeId: string;
  enabled: boolean;
  capacityClass: string;
  bandwidthLimitKbps: number;
  allowedScopes: string[];
  status: string;
  lastMeasuredAt: number;
  updatedAt: number;
}

export interface FabricRegistryTransport {
  id: string;
  nodeId: string;
  ownerType: string;
  ownerId: string;
  kind: string;
  endpoint: string;
  priority: number;
  health: string;
  lastError: string;
  lastSeenAt: number;
  provider: string;
  routeRole: string;
  trustLevel: string;
  updatedAt: number;
}

export interface FabricRegistryProject {
  id: string;
  nodeId: string;
  pathHash: string;
  displayPath: string;
  name: string;
  vcs: string;
  permissions: string[];
  lastOpenedAt: number;
  updatedAt: number;
}

export interface FabricRegistryRuntime {
  id: string;
  nodeId: string;
  provider: string;
  mode: string;
  version: string;
  capabilities: string[];
  status: string;
  updatedAt: number;
}

export interface FabricRegistryResult {
  version: number;
  nodes: FabricRegistryNode[];
  relayNodes: FabricRegistryRelayNode[];
  transports: FabricRegistryTransport[];
  projects: FabricRegistryProject[];
  runtimes: FabricRegistryRuntime[];
  counts: FabricRegistryCounts;
}

export interface FabricRegistryNodeView {
  node: FabricRegistryNode;
  relayNode: FabricRegistryRelayNode | null;
  transports: FabricRegistryTransport[];
  projects: FabricRegistryProject[];
  runtimes: FabricRegistryRuntime[];
}

export interface FabricRegistryRelayView {
  relayNode: FabricRegistryRelayNode;
  node: FabricRegistryNode | null;
  transports: FabricRegistryTransport[];
  health: string;
}

export interface ActiveFabricRegistryResult extends FabricRegistryResult {
  activeProfileId: string;
  activeProfileSource: string;
  profile: ControlPlaneProfile;
}

function normalizeText(value: unknown, maxLength = 512) {
  const text = String(value ?? '').trim();
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function normalizeNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function normalizeBoolean(value: unknown, fallback = false) {
  if (value === true || value === false) return value;
  return fallback;
}

function normalizeStringArray(value: unknown, maxLength = 96) {
  return Array.from(new Set((Array.isArray(value) ? value : [])
    .map((item) => normalizeText(item, maxLength))
    .filter(Boolean)));
}

function normalizeObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function normalizeArray<T>(value: unknown, mapper: (item: unknown) => T | null): T[] {
  return (Array.isArray(value) ? value : [])
    .map(mapper)
    .filter((item): item is T => Boolean(item));
}

function normalizeNode(value: unknown): FabricRegistryNode | null {
  const source = normalizeObject(value);
  const id = normalizeText(source.id, 96);
  if (!id) return null;
  return {
    id,
    name: normalizeText(source.name, 120) || id,
    roles: normalizeStringArray(source.roles, 64),
    platform: normalizeText(source.platform, 64),
    arch: normalizeText(source.arch, 64),
    ownerDeviceId: normalizeText(source.ownerDeviceId, 96),
    capabilities: normalizeStringArray(source.capabilities, 96),
    status: normalizeText(source.status, 32) || 'unknown',
    tags: normalizeStringArray(source.tags, 64),
    lastSeenAt: normalizeNumber(source.lastSeenAt),
    updatedAt: normalizeNumber(source.updatedAt)
  };
}

function normalizeRelayNode(value: unknown): FabricRegistryRelayNode | null {
  const source = normalizeObject(value);
  const id = normalizeText(source.id, 96);
  const nodeId = normalizeText(source.nodeId, 96);
  if (!id || !nodeId) return null;
  return {
    id,
    nodeId,
    enabled: normalizeBoolean(source.enabled, true),
    capacityClass: normalizeText(source.capacityClass, 64) || 'tiny',
    bandwidthLimitKbps: normalizeNumber(source.bandwidthLimitKbps),
    allowedScopes: normalizeStringArray(source.allowedScopes, 96),
    status: normalizeText(source.status, 32) || 'unknown',
    lastMeasuredAt: normalizeNumber(source.lastMeasuredAt),
    updatedAt: normalizeNumber(source.updatedAt)
  };
}

function normalizeTransport(value: unknown): FabricRegistryTransport | null {
  const source = normalizeObject(value);
  const id = normalizeText(source.id, 96);
  const nodeId = normalizeText(source.nodeId, 96);
  const kind = normalizeText(source.kind, 64);
  if (!id || !nodeId || !kind) return null;
  return {
    id,
    nodeId,
    ownerType: normalizeText(source.ownerType, 64),
    ownerId: normalizeText(source.ownerId, 96),
    kind,
    endpoint: normalizeText(source.endpoint, 2048),
    priority: normalizeNumber(source.priority),
    health: normalizeText(source.health, 32) || 'unknown',
    lastError: normalizeText(source.lastError, 512),
    lastSeenAt: normalizeNumber(source.lastSeenAt),
    provider: normalizeText(source.provider, 64),
    routeRole: normalizeText(source.routeRole, 64),
    trustLevel: normalizeText(source.trustLevel, 64),
    updatedAt: normalizeNumber(source.updatedAt)
  };
}

function normalizeProject(value: unknown): FabricRegistryProject | null {
  const source = normalizeObject(value);
  const id = normalizeText(source.id, 96);
  const nodeId = normalizeText(source.nodeId, 96);
  if (!id || !nodeId) return null;
  return {
    id,
    nodeId,
    pathHash: normalizeText(source.pathHash, 160),
    displayPath: normalizeText(source.displayPath, 2048),
    name: normalizeText(source.name, 120) || id,
    vcs: normalizeText(source.vcs, 32),
    permissions: normalizeStringArray(source.permissions, 64),
    lastOpenedAt: normalizeNumber(source.lastOpenedAt),
    updatedAt: normalizeNumber(source.updatedAt)
  };
}

function normalizeRuntime(value: unknown): FabricRegistryRuntime | null {
  const source = normalizeObject(value);
  const id = normalizeText(source.id, 96);
  const nodeId = normalizeText(source.nodeId, 96);
  const provider = normalizeText(source.provider, 64);
  if (!id || !nodeId || !provider) return null;
  return {
    id,
    nodeId,
    provider,
    mode: normalizeText(source.mode, 64) || 'tui',
    version: normalizeText(source.version, 120),
    capabilities: normalizeStringArray(source.capabilities, 96),
    status: normalizeText(source.status, 32) || 'unknown',
    updatedAt: normalizeNumber(source.updatedAt)
  };
}

function normalizeCounts(value: unknown, fallback: FabricRegistryCounts): FabricRegistryCounts {
  const source = normalizeObject(value);
  return {
    nodes: normalizeNumber(source.nodes) || fallback.nodes,
    relayNodes: normalizeNumber(source.relayNodes) || fallback.relayNodes,
    transports: normalizeNumber(source.transports) || fallback.transports,
    projects: normalizeNumber(source.projects) || fallback.projects,
    runtimes: normalizeNumber(source.runtimes) || fallback.runtimes
  };
}

function unwrapRegistryPayload(payload: unknown): unknown {
  const source = normalizeObject(payload);
  if ('result' in source) return source.result;
  return payload;
}

export function normalizeFabricRegistryResult(payload: unknown): FabricRegistryResult {
  const source = normalizeObject(unwrapRegistryPayload(payload));
  const nodes = normalizeArray(source.nodes, normalizeNode);
  const relayNodes = normalizeArray(source.relayNodes, normalizeRelayNode);
  const transports = normalizeArray(source.transports, normalizeTransport);
  const projects = normalizeArray(source.projects, normalizeProject);
  const runtimes = normalizeArray(source.runtimes, normalizeRuntime);
  const fallbackCounts = {
    nodes: nodes.length,
    relayNodes: relayNodes.length,
    transports: transports.length,
    projects: projects.length,
    runtimes: runtimes.length
  };
  return {
    version: normalizeNumber(source.version) || 1,
    nodes,
    relayNodes,
    transports,
    projects,
    runtimes,
    counts: normalizeCounts(source.counts, fallbackCounts)
  };
}

export function buildFabricRegistryNodeViews(registry: FabricRegistryResult): FabricRegistryNodeView[] {
  return registry.nodes.map((node) => ({
    node,
    relayNode: registry.relayNodes.find((relayNode) => relayNode.nodeId === node.id) || null,
    transports: registry.transports.filter((transport) => transport.nodeId === node.id),
    projects: registry.projects.filter((project) => project.nodeId === node.id),
    runtimes: registry.runtimes.filter((runtime) => runtime.nodeId === node.id)
  }));
}

export function buildFabricRegistryRelayViews(registry: FabricRegistryResult): FabricRegistryRelayView[] {
  return registry.relayNodes.map((relayNode) => {
    const transports = registry.transports.filter((transport) => (
      transport.nodeId === relayNode.nodeId
        && (transport.ownerId === relayNode.id || transport.kind === 'relay')
    ));
    const transportHealth = transports.map((transport) => transport.health);
    const health = !relayNode.enabled
      ? 'disabled'
      : transportHealth.includes('up')
        ? 'partial'
        : transportHealth.includes('down')
          ? 'degraded'
          : 'pending-measurement';
    return {
      relayNode,
      node: registry.nodes.find((node) => node.id === relayNode.nodeId) || null,
      transports,
      health
    };
  });
}

export async function fetchFabricRegistry(
  profile: Pick<ControlPlaneProfile, 'endpoint' | 'deviceToken'>,
  options: {
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
  } = {}
): Promise<FabricRegistryResult> {
  const client = createControlPlaneApiClient({
    endpoint: profile.endpoint,
    token: profile.deviceToken,
    timeoutMs: options.timeoutMs,
    fetchImpl: options.fetchImpl
  });
  const payload = await client.getJson('/v0/fabric/registry', {
    requireToken: true,
    httpErrorPrefix: 'fabric_registry_http'
  });
  return normalizeFabricRegistryResult(payload);
}

export async function readActiveFabricRegistry(options: {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
} = {}): Promise<ActiveFabricRegistryResult> {
  const context = resolveStoredActiveControlPlaneContext();
  const profile = requireActiveControlPlaneProfile(context);
  try {
    const registry = await fetchFabricRegistry(profile, options);
    return {
      ...registry,
      activeProfileId: profile.id,
      activeProfileSource: context.source,
      profile
    };
  } catch (error) {
    markActiveControlPlaneProfileDegraded(profile, error);
    throw error;
  }
}
