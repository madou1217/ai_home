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
  measurement: FabricRegistryTransportMeasurement | null;
}

export interface FabricRegistryTransportMeasurement {
  status: string;
  durationMs: number;
  successes: number;
  failures: number;
  sampleCount: number;
  successRate: number | null;
  failureReason: string;
  measuredAt: number;
  rttMs: {
    min: number;
    p50: number;
    p95: number;
    max: number;
    avg: number;
    count: number;
  } | null;
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

export interface FabricRegistryNetworkMeasurement {
  id: string;
  nodeId: string;
  transportId: string;
  transportKind: string;
  ownerType: string;
  ownerId: string;
  status: string;
  durationMs: number;
  successes: number;
  failures: number;
  sampleCount: number;
  successRate: number | null;
  failureReason: string;
  measuredAt: number;
  createdAt: number;
  rttMs: FabricRegistryTransportMeasurement['rttMs'];
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

export interface FabricNodeAction {
  id: string;
  label: string;
  enabled: boolean;
  eligible: boolean;
  blockers: string[];
  provider: string;
  runtimeId: string;
  runtimeStatus: string;
}

export interface FabricNodeRuntimeGap {
  provider: string;
  status: string;
  blocker: string;
  runtimeId: string;
}

export interface FabricNodeCapabilities {
  server: boolean;
  node: boolean;
  relayNode: boolean;
  projectHost: boolean;
  runtimeHost: boolean;
  sshBootstrap: boolean;
  measured: boolean;
  transportKinds: string[];
  runtimeProviders: string[];
  relayState: string;
  transportState: string;
}

export interface FabricNodeInventoryItem {
  id: string;
  name: string;
  node: FabricRegistryNode;
  relayNode: FabricRegistryRelayNode | null;
  projects: FabricRegistryProject[];
  runtimes: FabricRegistryRuntime[];
  transports: FabricRegistryTransport[];
  networkMeasurements: FabricRegistryNetworkMeasurement[];
  capabilities: FabricNodeCapabilities;
  runtimeGaps: FabricNodeRuntimeGap[];
  actions: FabricNodeAction[];
}

export interface FabricRegistryResult {
  version: number;
  nodes: FabricRegistryNode[];
  relayNodes: FabricRegistryRelayNode[];
  transports: FabricRegistryTransport[];
  projects: FabricRegistryProject[];
  runtimes: FabricRegistryRuntime[];
  networkMeasurements: FabricRegistryNetworkMeasurement[];
  nodeInventory: FabricNodeInventoryItem[];
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

function normalizeRatio(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.max(0, Math.min(1, number));
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

function normalizeLowerText(value: unknown, maxLength = 512) {
  return normalizeText(value, maxLength).toLowerCase();
}

function normalizeObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function normalizeArray<T>(value: unknown, mapper: (item: unknown) => T | null): T[] {
  return (Array.isArray(value) ? value : [])
    .map(mapper)
    .filter((item): item is T => Boolean(item));
}

function normalizeRttMetrics(value: unknown): FabricRegistryTransportMeasurement['rttMs'] {
  const source = normalizeObject(value);
  const keys = ['min', 'p50', 'p95', 'max', 'avg', 'count'] as const;
  const hasValue = keys.some((key) => source[key] !== undefined && source[key] !== null && source[key] !== '');
  if (!hasValue) return null;
  return {
    min: normalizeNumber(source.min),
    p50: normalizeNumber(source.p50),
    p95: normalizeNumber(source.p95),
    max: normalizeNumber(source.max),
    avg: normalizeNumber(source.avg),
    count: normalizeNumber(source.count)
  };
}

function normalizeTransportMeasurement(value: unknown): FabricRegistryTransportMeasurement | null {
  const source = normalizeObject(value);
  const rttMs = normalizeRttMetrics(source.rttMs);
  const hasValue = Boolean(
    normalizeText(source.status, 96)
      || normalizeNumber(source.durationMs)
      || normalizeNumber(source.successes)
      || normalizeNumber(source.failures)
      || normalizeNumber(source.sampleCount)
      || normalizeRatio(source.successRate) !== null
      || normalizeText(source.failureReason, 160)
      || normalizeNumber(source.measuredAt)
      || rttMs
  );
  if (!hasValue) return null;
  return {
    status: normalizeText(source.status, 96),
    durationMs: normalizeNumber(source.durationMs),
    successes: normalizeNumber(source.successes),
    failures: normalizeNumber(source.failures),
    sampleCount: normalizeNumber(source.sampleCount),
    successRate: normalizeRatio(source.successRate),
    failureReason: normalizeText(source.failureReason, 160),
    measuredAt: normalizeNumber(source.measuredAt),
    rttMs
  };
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
    updatedAt: normalizeNumber(source.updatedAt),
    measurement: normalizeTransportMeasurement(source.measurement)
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

function normalizeNetworkMeasurement(value: unknown): FabricRegistryNetworkMeasurement | null {
  const source = normalizeObject(value);
  const id = normalizeText(source.id, 96);
  const nodeId = normalizeText(source.nodeId, 96);
  const transportId = normalizeText(source.transportId, 96);
  if (!id || !nodeId || !transportId) return null;
  return {
    id,
    nodeId,
    transportId,
    transportKind: normalizeText(source.transportKind, 64),
    ownerType: normalizeText(source.ownerType, 64),
    ownerId: normalizeText(source.ownerId, 96),
    status: normalizeText(source.status, 96),
    durationMs: normalizeNumber(source.durationMs),
    successes: normalizeNumber(source.successes),
    failures: normalizeNumber(source.failures),
    sampleCount: normalizeNumber(source.sampleCount),
    successRate: normalizeRatio(source.successRate),
    failureReason: normalizeText(source.failureReason, 160),
    measuredAt: normalizeNumber(source.measuredAt),
    createdAt: normalizeNumber(source.createdAt),
    rttMs: normalizeRttMetrics(source.rttMs)
  };
}

function normalizeAction(value: unknown): FabricNodeAction | null {
  const source = normalizeObject(value);
  const id = normalizeText(source.id, 120);
  if (!id) return null;
  return {
    id,
    label: normalizeText(source.label, 160) || id,
    enabled: normalizeBoolean(source.enabled),
    eligible: normalizeBoolean(source.eligible),
    blockers: normalizeStringArray(source.blockers, 128),
    provider: normalizeText(source.provider, 64),
    runtimeId: normalizeText(source.runtimeId, 96),
    runtimeStatus: normalizeText(source.runtimeStatus, 64)
  };
}

function normalizeRuntimeGap(value: unknown): FabricNodeRuntimeGap | null {
  const source = normalizeObject(value);
  const provider = normalizeText(source.provider, 64);
  const blocker = normalizeText(source.blocker, 128);
  if (!provider || !blocker) return null;
  return {
    provider,
    status: normalizeText(source.status, 64) || 'unknown',
    blocker,
    runtimeId: normalizeText(source.runtimeId, 96)
  };
}

function normalizeNodeCapabilities(value: unknown): FabricNodeCapabilities {
  const source = normalizeObject(value);
  return {
    server: normalizeBoolean(source.server),
    node: normalizeBoolean(source.node),
    relayNode: normalizeBoolean(source.relayNode),
    projectHost: normalizeBoolean(source.projectHost),
    runtimeHost: normalizeBoolean(source.runtimeHost),
    sshBootstrap: normalizeBoolean(source.sshBootstrap),
    measured: normalizeBoolean(source.measured),
    transportKinds: normalizeStringArray(source.transportKinds, 64),
    runtimeProviders: normalizeStringArray(source.runtimeProviders, 64),
    relayState: normalizeText(source.relayState, 64) || 'unknown',
    transportState: normalizeText(source.transportState, 64) || 'unknown'
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

function isOnlineStatus(value: unknown) {
  return ['available', 'healthy', 'online', 'ready', 'up'].includes(normalizeLowerText(value, 64));
}

function isDegradedStatus(value: unknown) {
  return ['degraded', 'partial', 'pending', 'warning'].includes(normalizeLowerText(value, 64));
}

function isOfflineStatus(value: unknown) {
  return ['disabled', 'down', 'failed', 'offline', 'unhealthy'].includes(normalizeLowerText(value, 64));
}

function hasMeasurement(transport: FabricRegistryTransport) {
  const measurement = transport.measurement;
  return Boolean(
    measurement
      && (
        measurement.status
        || measurement.durationMs
        || measurement.sampleCount
        || measurement.measuredAt
        || (measurement.rttMs && measurement.rttMs.count !== undefined)
      )
  );
}

function summarizeTransportState(transports: FabricRegistryTransport[]) {
  if (transports.length === 0) return 'missing';
  if (transports.some((transport) => isOnlineStatus(transport.health))) return 'online';
  if (transports.some((transport) => isDegradedStatus(transport.health))) return 'degraded';
  if (transports.every((transport) => isOfflineStatus(transport.health))) return 'offline';
  return 'unknown';
}

function summarizeRelayState(relayNode: FabricRegistryRelayNode | null, transports: FabricRegistryTransport[]) {
  if (!relayNode) return 'missing';
  if (relayNode.enabled === false) return 'disabled';
  const transportState = summarizeTransportState(transports);
  if (transportState !== 'missing' && transportState !== 'unknown') return transportState;
  return relayNode.status || 'unknown';
}

function buildAction(
  id: string,
  label: string,
  enabled: boolean,
  blockers: string[] = [],
  extra: Partial<FabricNodeAction> = {}
): FabricNodeAction {
  const uniqueBlockers = normalizeStringArray(blockers, 128);
  return {
    id,
    label,
    enabled: Boolean(enabled) && uniqueBlockers.length === 0,
    eligible: Boolean(extra.eligible),
    blockers: uniqueBlockers,
    provider: extra.provider || '',
    runtimeId: extra.runtimeId || '',
    runtimeStatus: extra.runtimeStatus || '',
    ...extra
  };
}

function resolveProviderRuntimeGate(provider: string, view: Omit<FabricNodeInventoryItem, 'capabilities' | 'actions' | 'runtimeGaps'>) {
  const runtime = view.runtimes.find((item) => normalizeLowerText(item.provider, 64) === provider) || null;
  const runtimeStatus = runtime ? (runtime.status || 'available') : 'missing';
  const runtimeReady = Boolean(runtime) && !isOfflineStatus(runtimeStatus);
  const blocker = !runtime
    ? `missing_provider_runtime:${provider}`
    : (!runtimeReady ? `provider_runtime_not_ready:${provider}:${runtimeStatus}` : '');
  return {
    runtime,
    runtimeStatus,
    runtimeReady,
    blocker
  };
}

function buildStartSessionAction(provider: string, view: Omit<FabricNodeInventoryItem, 'capabilities' | 'actions' | 'runtimeGaps'>): FabricNodeAction {
  const hasProjects = view.projects.length > 0;
  const runtimeGate = resolveProviderRuntimeGate(provider, view);
  const hasTransport = view.transports.length > 0;
  const blockers = [
    ...(hasProjects ? [] : ['missing_project_snapshot']),
    ...(runtimeGate.blocker ? [runtimeGate.blocker] : []),
    ...(hasTransport ? [] : ['missing_transport'])
  ];
  const eligible = hasProjects && runtimeGate.runtimeReady && hasTransport;
  return buildAction(`start-session:${provider}`, `Start ${provider}`, eligible, blockers, {
    provider,
    eligible,
    runtimeId: runtimeGate.runtime?.id || '',
    runtimeStatus: runtimeGate.runtimeStatus
  });
}

function buildRuntimeGaps(view: Omit<FabricNodeInventoryItem, 'capabilities' | 'actions' | 'runtimeGaps'>): FabricNodeRuntimeGap[] {
  return ['codex', 'claude', 'agy', 'opencode']
    .map((provider) => {
      const gate = resolveProviderRuntimeGate(provider, view);
      if (!gate.blocker) return null;
      return {
        provider,
        status: gate.runtimeStatus,
        blocker: gate.blocker,
        runtimeId: gate.runtime?.id || ''
      };
    })
    .filter((item): item is FabricNodeRuntimeGap => Boolean(item));
}

function buildNodeCapabilities(view: Omit<FabricNodeInventoryItem, 'capabilities' | 'actions' | 'runtimeGaps'>): FabricNodeCapabilities {
  const roles = view.node.roles.map((role) => normalizeLowerText(role, 64));
  const declaredCapabilities = view.node.capabilities.map((capability) => normalizeLowerText(capability, 96));
  const relayTransports = view.transports.filter((transport) => normalizeLowerText(transport.kind, 64) === 'relay');
  const sshTransports = view.transports.filter((transport) => normalizeLowerText(transport.kind, 64) === 'ssh');
  const transportKinds = Array.from(new Set(view.transports.map((transport) => normalizeLowerText(transport.kind, 64)).filter(Boolean))).sort();
  const runtimeProviders = Array.from(new Set(view.runtimes.map((runtime) => normalizeLowerText(runtime.provider, 64)).filter(Boolean))).sort();
  return {
    server: roles.includes('server'),
    node: roles.includes('node'),
    relayNode: Boolean(view.relayNode) || roles.includes('relay-node'),
    projectHost: view.projects.length > 0 || declaredCapabilities.includes('projects'),
    runtimeHost: runtimeProviders.length > 0 || declaredCapabilities.includes('runtimes') || declaredCapabilities.includes('sessions'),
    sshBootstrap: sshTransports.length > 0 || declaredCapabilities.includes('ssh-bootstrap') || declaredCapabilities.includes('ssh'),
    measured: view.transports.some(hasMeasurement),
    transportKinds,
    runtimeProviders,
    relayState: summarizeRelayState(view.relayNode, relayTransports),
    transportState: summarizeTransportState(view.transports)
  };
}

function buildNodeActions(view: Omit<FabricNodeInventoryItem, 'actions' | 'runtimeGaps'>): FabricNodeAction[] {
  return [
    buildAction('open-project', 'Open project', false, [
      ...(view.projects.length > 0 ? [] : ['missing_project_snapshot']),
      'm4_project_action_pending'
    ], { eligible: view.projects.length > 0 }),
    ...['codex', 'claude', 'agy', 'opencode'].map((provider) => buildStartSessionAction(provider, view)),
    buildAction('configure-ssh', 'Configure SSH', view.capabilities.sshBootstrap, view.capabilities.sshBootstrap ? [] : ['missing_ssh_bootstrap_transport'], {
      eligible: view.capabilities.sshBootstrap
    }),
    buildAction('run-measurement', 'Run measurement', view.transports.length > 0, view.transports.length > 0 ? [] : ['missing_transport'], {
      eligible: view.transports.length > 0
    }),
    buildAction('enable-relay', 'Enable relay', false, view.relayNode ? ['relay_already_registered'] : ['relay_role_enable_flow_pending'], {
      eligible: !view.relayNode
    })
  ];
}

export function buildFabricNodeInventory(registry: Pick<FabricRegistryResult, 'nodes' | 'relayNodes' | 'transports' | 'projects' | 'runtimes' | 'networkMeasurements'>): FabricNodeInventoryItem[] {
  return registry.nodes.map((node) => {
    const view = {
      id: node.id,
      name: node.name || node.id,
      node,
      relayNode: registry.relayNodes.find((relayNode) => relayNode.nodeId === node.id) || null,
      transports: registry.transports.filter((transport) => transport.nodeId === node.id),
      projects: registry.projects.filter((project) => project.nodeId === node.id),
      runtimes: registry.runtimes.filter((runtime) => runtime.nodeId === node.id),
      networkMeasurements: registry.networkMeasurements.filter((measurement) => measurement.nodeId === node.id)
    };
    const capabilities = buildNodeCapabilities(view);
    const withCapabilities = { ...view, capabilities };
    return {
      ...withCapabilities,
      runtimeGaps: buildRuntimeGaps(withCapabilities),
      actions: buildNodeActions(withCapabilities)
    };
  });
}

function normalizeNodeInventory(value: unknown, registry: Pick<FabricRegistryResult, 'nodes' | 'relayNodes' | 'transports' | 'projects' | 'runtimes' | 'networkMeasurements'>): FabricNodeInventoryItem[] {
  const raw = Array.isArray(value) ? value : [];
  if (raw.length === 0) return buildFabricNodeInventory(registry);
  const fallback = buildFabricNodeInventory(registry);
  return raw.map((item) => {
    const source = normalizeObject(item);
    const id = normalizeText(source.id, 96);
    const base = fallback.find((entry) => entry.id === id) || null;
    if (!id || !base) return null;
    const hasRuntimeGaps = Array.isArray(source.runtimeGaps);
    return {
      ...base,
      name: normalizeText(source.name, 120) || base.name,
      capabilities: normalizeNodeCapabilities(source.capabilities || base.capabilities),
      runtimeGaps: hasRuntimeGaps ? normalizeArray(source.runtimeGaps, normalizeRuntimeGap) : base.runtimeGaps,
      actions: normalizeArray(source.actions, normalizeAction)
    };
  }).filter((item): item is FabricNodeInventoryItem => Boolean(item));
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
  const networkMeasurements = normalizeArray(source.networkMeasurements, normalizeNetworkMeasurement);
  const registryForInventory = {
    nodes,
    relayNodes,
    transports,
    projects,
    runtimes,
    networkMeasurements
  };
  const nodeInventory = normalizeNodeInventory(source.nodeInventory, registryForInventory);
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
    networkMeasurements,
    nodeInventory,
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
    const transportHealth = transports.map((transport) => String(transport.health || '').toLowerCase());
    const health = !relayNode.enabled
      ? 'disabled'
      : transportHealth.some((value) => value === 'online' || value === 'up' || value === 'healthy')
        ? 'online'
        : transportHealth.some((value) => value === 'degraded' || value === 'partial' || value === 'warning')
          ? 'degraded'
          : transportHealth.some((value) => value === 'offline' || value === 'down' || value === 'failed' || value === 'unhealthy')
            ? 'offline'
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
