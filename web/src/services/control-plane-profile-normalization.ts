'use strict';

import {
  buildControlPlaneHttpUrl,
  normalizeControlPlaneEndpoint,
} from './control-plane-api-client';

import {
  isNativeDesktopRuntime,
} from './native-server-profile-repository';

import {
  migrateLegacyServerRoutes,
  normalizeStableServerId,
} from './server-routes/server-route-service';

import {
  providerIds,
} from '../providers/catalog';

import type {
  ControlPlaneDescriptor,
  ControlPlaneDeviceAccountsResponse,
  ControlPlaneDeviceAccountSummary,
  ControlPlaneDeviceSessionEvent,
  ControlPlaneDeviceSessionEventsResponse,
  ControlPlaneDeviceNodeSessionInputResponse,
  ControlPlaneDeviceNodeSessionMessagesResponse,
  ControlPlaneDeviceNodeSessionsResponse,
  ControlPlaneDeviceNodeSessionStreamFrame,
  ControlPlaneDeviceSessionStreamFrame,
  ControlPlaneDeviceSessionMessagesResponse,
  ControlPlaneDeviceSessionMessagesSummary,
  ControlPlaneDeviceSessionsResponse,
  ControlPlaneDeviceSessionSummary,
  ControlPlaneDeviceNodesResponse,
  ControlPlaneDeviceStatus,
  ControlPlaneDeviceStatusResponse,
  ControlPlaneNodeSummary,
  ControlPlaneProfileBroker,
  ControlPlaneProfileConnectionMode,
  ControlPlaneProfileState,
  ControlPlaneProfile,
  ServerAuthorizationState,
  ServerRoute,
} from '@/types';

const MAX_PROFILE_NODE_CACHE = 100;

export const CONTROL_PLANE_PROFILE_STATES: ControlPlaneProfileState[] = [
  'ready',
  'degraded',
  'offline'
];

export const CONTROL_PLANE_PROFILE_CONNECTION_MODES: ControlPlaneProfileConnectionMode[] = [
  'direct',
  'broker-proxy'
];

export interface ControlPlaneProfileEndpointInput {
  endpoint?: string;
  connectionMode?: ControlPlaneProfileConnectionMode;
  brokerEndpoint?: string;
  brokerServerId?: string;
  broker?: ControlPlaneProfileBroker | null;
}

export interface ControlPlaneProfileEndpointResolution {
  endpoint: string;
  connectionMode: ControlPlaneProfileConnectionMode;
  broker: ControlPlaneProfileBroker | null;
}

export function normalizeText(value: unknown, maxLength = 512) {
  const text = String(value ?? '').trim();
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

export function hasConfiguredManagementKey(input: {
  managementKey?: unknown;
  managementKeyConfigured?: unknown;
} | null | undefined) {
  return Boolean(
    input
      && (input.managementKeyConfigured === true || normalizeText(input.managementKey, 4096))
  );
}

function normalizeFabricServerId(value: unknown) {
  const raw = normalizeText(value, 128).toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/[^a-z0-9]+$/, '')
    .slice(0, 64);
  return /^[a-z0-9][a-z0-9_.-]{1,63}$/.test(raw) ? raw : '';
}

export function buildFabricBrokerProxyEndpoint(brokerEndpoint: string, serverId: string): string {
  const endpoint = normalizeControlPlaneEndpoint(brokerEndpoint);
  const normalizedServerId = normalizeFabricServerId(serverId);
  if (!endpoint || !normalizedServerId) return '';
  const encoded = encodeURIComponent(normalizedServerId);
  return buildControlPlaneHttpUrl(endpoint, `/v0/fabric/broker/servers/${encoded}/proxy`);
}

function parseFabricBrokerProxyEndpoint(endpoint: string): ControlPlaneProfileBroker | null {
  const normalized = normalizeControlPlaneEndpoint(endpoint);
  if (!normalized) return null;
  try {
    const url = new URL(normalized);
    const marker = '/v0/fabric/broker/servers/';
    const markerIndex = url.pathname.indexOf(marker);
    if (markerIndex < 0) return null;
    const rest = url.pathname.slice(markerIndex + marker.length);
    const parts = rest.split('/').filter(Boolean);
    if (parts.length < 2 || parts[1] !== 'proxy') return null;
    const serverId = normalizeFabricServerId(decodeURIComponent(parts[0] || ''));
    if (!serverId) return null;
    const brokerPath = url.pathname.slice(0, markerIndex).replace(/\/+$/, '');
    const brokerEndpoint = normalizeControlPlaneEndpoint(`${url.protocol}//${url.host}${brokerPath}`);
    const proxyEndpoint = buildFabricBrokerProxyEndpoint(brokerEndpoint, serverId);
    if (!brokerEndpoint || proxyEndpoint !== normalized) return null;
    return {
      brokerEndpoint,
      serverId,
      proxyEndpoint
    };
  } catch (_error) {
    return null;
  }
}

export function normalizeProfileConnectionMode(value: unknown, endpoint = ''): ControlPlaneProfileConnectionMode {
  const mode = normalizeText(value, 32).toLowerCase();
  if (CONTROL_PLANE_PROFILE_CONNECTION_MODES.includes(mode as ControlPlaneProfileConnectionMode)) {
    return mode as ControlPlaneProfileConnectionMode;
  }
  return parseFabricBrokerProxyEndpoint(endpoint) ? 'broker-proxy' : 'direct';
}

export function normalizeProfileBroker(value: unknown, endpoint = ''): ControlPlaneProfileBroker | null {
  const inferred = parseFabricBrokerProxyEndpoint(endpoint);
  const source = value && typeof value === 'object'
    ? value as Partial<ControlPlaneProfileBroker>
    : null;
  const brokerEndpoint = normalizeControlPlaneEndpoint(source?.brokerEndpoint || inferred?.brokerEndpoint || '');
  const serverId = normalizeFabricServerId(source?.serverId || inferred?.serverId || '');
  const proxyEndpoint = buildFabricBrokerProxyEndpoint(brokerEndpoint, serverId);
  if (!brokerEndpoint || !serverId || !proxyEndpoint) return inferred;
  return {
    brokerEndpoint,
    serverId,
    proxyEndpoint
  };
}

export function resolveControlPlaneProfileEndpointInput(
  input: ControlPlaneProfileEndpointInput
): ControlPlaneProfileEndpointResolution {
  const endpoint = normalizeControlPlaneEndpoint(input.endpoint || '');
  const connectionMode = normalizeProfileConnectionMode(input.connectionMode, endpoint);
  if (connectionMode === 'broker-proxy') {
    const broker = normalizeProfileBroker(input.broker || {
      brokerEndpoint: input.brokerEndpoint,
      serverId: input.brokerServerId,
      proxyEndpoint: endpoint
    }, endpoint);
    if (!broker) {
      throw new Error('invalid_fabric_broker_profile');
    }
    return {
      endpoint: broker.proxyEndpoint,
      connectionMode: 'broker-proxy',
      broker
    };
  }
  if (!endpoint) {
    throw new Error('invalid_control_plane_endpoint');
  }
  return {
    endpoint,
    connectionMode: 'direct',
    broker: null
  };
}

export function getCurrentWebUiControlPlaneEndpoint() {
  if (typeof window === 'undefined') return '';
  const origin = normalizeText(window.location?.origin, 512);
  if (!/^https?:\/\//i.test(origin)) return '';
  return normalizeControlPlaneEndpoint(origin);
}

export function normalizeControlPlaneProfileState(
  value: unknown,
  fallback: ControlPlaneProfileState = 'offline'
): ControlPlaneProfileState {
  const state = normalizeText(value, 64).toLowerCase() as ControlPlaneProfileState;
  return CONTROL_PLANE_PROFILE_STATES.includes(state) ? state : fallback;
}

export function inferProfileState(input: {
  requestedState?: unknown;
  existing?: Partial<ControlPlaneProfile> | null;
  managementKey?: unknown;
  managementKeyConfigured?: unknown;
  lastError?: string;
}): ControlPlaneProfileState {
  const explicitState = normalizeText(input.requestedState, 64).toLowerCase();
  if (CONTROL_PLANE_PROFILE_STATES.includes(explicitState as ControlPlaneProfileState)) {
    return explicitState as ControlPlaneProfileState;
  }
  if (input.lastError) return 'degraded';
  const managementKeyConfigured = hasConfiguredManagementKey({
    managementKey: input.managementKey,
    managementKeyConfigured: input.managementKeyConfigured
  }) || hasConfiguredManagementKey(input.existing);
  const existingState = normalizeControlPlaneProfileState(input.existing?.state, 'offline');
  if (existingState === 'degraded' && managementKeyConfigured) return 'degraded';
  return managementKeyConfigured ? 'ready' : 'offline';
}

export function buildControlPlaneDescriptorUrl(endpoint: string): string {
  return buildControlPlaneHttpUrl(endpoint, '/v0/node-rpc/descriptor');
}

export function stableProfileId(endpoint: string) {
  let hash = 2166136261;
  for (const char of endpoint) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `cp-${(hash >>> 0).toString(36)}`;
}

export function resolveServerAuthorizationState(
  managementKeyConfigured: boolean
): ServerAuthorizationState {
  return managementKeyConfigured ? 'authorized' : 'discovered-pending-auth';
}

export function selectProfileRoute(
  routes: ServerRoute[],
  activeRouteId: unknown,
  endpoint: unknown
): ServerRoute | null {
  const routeId = normalizeText(activeRouteId, 128);
  const normalizedEndpoint = normalizeControlPlaneEndpoint(String(endpoint || ''));
  return routes.find((route) => route.id === routeId)
    || routes.find((route) => route.endpoint === normalizedEndpoint)
    || routes[0]
    || null;
}

function normalizeDescriptor(value: unknown): ControlPlaneDescriptor | null {
  const source = value && typeof value === 'object' ? value as Partial<ControlPlaneDescriptor> : null;
  if (!source || source.service !== 'aih-control-plane') return null;
  const capabilities = source.capabilities && typeof source.capabilities === 'object'
    ? source.capabilities as Record<string, unknown>
    : {};
  const auth = source.auth && typeof source.auth === 'object'
    ? source.auth as Record<string, unknown>
    : {};
  return {
    ok: Boolean(source.ok),
    service: 'aih-control-plane',
    protocolVersion: Math.max(0, Number(source.protocolVersion) || 0),
    endpoint: normalizeControlPlaneEndpoint(String(source.endpoint || '')),
    host: normalizeText(source.host, 256),
    port: Math.max(0, Number(source.port) || 0),
    serverTime: normalizeText(source.serverTime, 128),
    uptimeSec: Math.max(0, Number(source.uptimeSec) || 0),
    auth: {
      managementKeyConfigured: Boolean(auth.managementKeyConfigured)
    },
    capabilities: {
      nodeRpc: Array.isArray(capabilities.nodeRpc) ? capabilities.nodeRpc.map(String).filter(Boolean) : [],
      management: Array.isArray(capabilities.management) ? capabilities.management.map(String).filter(Boolean) : [],
      remoteManagement: Boolean(capabilities.remoteManagement),
      remoteInvite: Boolean(capabilities.remoteInvite),
      transports: Array.isArray(capabilities.transports) ? capabilities.transports.map(String).filter(Boolean) : []
    }
  };
}

function normalizeFabricDescriptor(value: unknown): ControlPlaneDescriptor | null {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : null;
  if (!source || source.service !== 'aih-fabric') return null;
  const server = source.server && typeof source.server === 'object'
    ? source.server as Record<string, unknown>
    : {};
  const auth = source.auth && typeof source.auth === 'object'
    ? source.auth as Record<string, unknown>
    : {};
  const capabilities = source.capabilities && typeof source.capabilities === 'object'
    ? source.capabilities as Record<string, unknown>
    : {};
  const legacy = capabilities.legacyControlPlane && typeof capabilities.legacyControlPlane === 'object'
    ? capabilities.legacyControlPlane as Record<string, unknown>
    : {};
  return {
    ok: Boolean(source.ok),
    service: 'aih-control-plane',
    protocolVersion: Math.max(0, Number(legacy.protocolVersion) || 1),
    endpoint: normalizeControlPlaneEndpoint(String(server.endpoint || '')),
    host: normalizeText(server.host, 256),
    port: Math.max(0, Number(server.port) || 0),
    serverTime: normalizeText(server.serverTime, 128),
    uptimeSec: Math.max(0, Number(server.uptimeSec) || 0),
    auth: {
      managementKeyConfigured: Boolean(auth.managementKeyConfigured)
    },
    capabilities: {
      nodeRpc: Array.isArray(legacy.nodeRpc) ? legacy.nodeRpc.map(String).filter(Boolean) : [],
      management: Array.isArray(legacy.management) ? legacy.management.map(String).filter(Boolean) : [],
      remoteManagement: true,
      remoteInvite: true,
      transports: Array.isArray(capabilities.transports) ? capabilities.transports.map(String).filter(Boolean) : []
    }
  };
}

export function normalizeAnyDescriptor(value: unknown): ControlPlaneDescriptor | null {
  return normalizeFabricDescriptor(value) || normalizeDescriptor(value);
}

function normalizeStringArray(value: unknown) {
  return Array.isArray(value) ? value.map((item) => normalizeText(item, 96)).filter(Boolean) : [];
}

function normalizeCount(value: unknown) {
  return Math.max(0, Math.floor(Number(value) || 0));
}

function normalizeRate(value: unknown) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function normalizePercent(value: unknown) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : null;
}

function normalizeNumberMap(value: unknown): Record<string, number> {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return Object.keys(source).sort().reduce<Record<string, number>>((acc, key) => {
    const name = normalizeText(key, 64);
    if (name) acc[name] = normalizeCount(source[key]);
    return acc;
  }, {});
}

function normalizeProviderStatusMap(value: unknown): ControlPlaneDeviceStatus['providers'] {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return Object.keys(source).sort().reduce<ControlPlaneDeviceStatus['providers']>((acc, key) => {
    const provider = normalizeText(key, 64).toLowerCase();
    const item = source[key] && typeof source[key] === 'object'
      ? source[key] as { total?: unknown; active?: unknown; statuses?: unknown }
      : {};
    if (provider) {
      acc[provider] = {
        total: normalizeCount(item.total),
        active: normalizeCount(item.active),
        statuses: normalizeNumberMap(item.statuses)
      };
    }
    return acc;
  }, {});
}

function normalizeQueueMap(value: unknown): ControlPlaneDeviceStatus['queue'] {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return Object.keys(source).sort().reduce<ControlPlaneDeviceStatus['queue']>((acc, key) => {
    const provider = normalizeText(key, 64).toLowerCase();
    const item = source[key] && typeof source[key] === 'object'
      ? source[key] as Record<string, unknown>
      : {};
    if (provider) {
      acc[provider] = {
        name: normalizeText(item.name, 64),
        running: normalizeCount(item.running),
        queued: normalizeCount(item.queued),
        maxConcurrency: normalizeCount(item.maxConcurrency),
        queueLimit: normalizeCount(item.queueLimit),
        totalScheduled: normalizeCount(item.totalScheduled),
        totalRejected: normalizeCount(item.totalRejected)
      };
    }
    return acc;
  }, {});
}

export function normalizeDeviceStatus(value: unknown): ControlPlaneDeviceStatus | null {
  const payload = value && typeof value === 'object' ? value as Partial<ControlPlaneDeviceStatusResponse> : null;
  const result = payload?.result && typeof payload.result === 'object'
    ? payload.result as { status?: unknown }
    : null;
  const source = result?.status && typeof result.status === 'object'
    ? result.status as Partial<ControlPlaneDeviceStatus>
    : (value && typeof value === 'object' ? value as Partial<ControlPlaneDeviceStatus> : null);
  if (!source || source.service !== 'aih-control-plane') return null;
  const queue = normalizeQueueMap(source.queue);
  return {
    ok: Boolean(source.ok),
    service: 'aih-control-plane',
    serverTime: normalizeText(source.serverTime, 128),
    uptimeSec: normalizeCount(source.uptimeSec),
    backend: normalizeText(source.backend, 96),
    providerMode: normalizeText(source.providerMode, 64),
    strategy: normalizeText(source.strategy, 64),
    totalAccounts: normalizeCount(source.totalAccounts),
    activeAccounts: normalizeCount(source.activeAccounts),
    cooldownAccounts: normalizeCount(source.cooldownAccounts),
    statusTotals: normalizeNumberMap(source.statusTotals),
    providers: normalizeProviderStatusMap(source.providers),
    queue,
    queueTotals: {
      running: normalizeCount(source.queueTotals?.running),
      queued: normalizeCount(source.queueTotals?.queued),
      totalScheduled: normalizeCount(source.queueTotals?.totalScheduled),
      totalRejected: normalizeCount(source.queueTotals?.totalRejected)
    },
    modelsCached: normalizeCount(source.modelsCached),
    modelsUpdatedAt: normalizeCount(source.modelsUpdatedAt),
    modelRegistryUpdatedAt: normalizeCount(source.modelRegistryUpdatedAt),
    successRate: normalizeRate(source.successRate),
    timeoutRate: normalizeRate(source.timeoutRate),
    totalRequests: normalizeCount(source.totalRequests)
  };
}

function normalizeControlPlaneProvider(value: unknown) {
  const provider = normalizeText(value, 64).toLowerCase();
  if (providerIds.includes(provider as (typeof providerIds)[number])) {
    return provider as ControlPlaneDeviceAccountsResponse['result']['accounts'][number]['provider'];
  }
  return 'codex';
}

function normalizeDeviceAccountSummary(value: unknown): ControlPlaneDeviceAccountSummary {
  const source = value && typeof value === 'object' ? value as Partial<ControlPlaneDeviceAccountSummary> : {};
  return {
    total: normalizeCount(source.total),
    active: normalizeCount(source.active),
    byProvider: normalizeNumberMap(source.byProvider),
    byRuntimeStatus: normalizeNumberMap(source.byRuntimeStatus),
    bySchedulableStatus: normalizeNumberMap(source.bySchedulableStatus)
  };
}

function normalizeDeviceSessionSummary(value: unknown): ControlPlaneDeviceSessionSummary {
  const source = value && typeof value === 'object' ? value as Partial<ControlPlaneDeviceSessionSummary> : {};
  return {
    total: normalizeCount(source.total),
    returned: normalizeCount(source.returned),
    byProvider: normalizeNumberMap(source.byProvider),
    byStatus: normalizeNumberMap(source.byStatus),
    byProject: normalizeNumberMap(source.byProject),
    recentlyUpdatedAt: Math.max(0, Number(source.recentlyUpdatedAt) || 0)
  };
}

export function normalizeDeviceAccounts(value: unknown) {
  const payload = value && typeof value === 'object' ? value as Partial<ControlPlaneDeviceAccountsResponse> : null;
  const result = payload?.result && typeof payload.result === 'object'
    ? payload.result as Partial<ControlPlaneDeviceAccountsResponse['result']>
    : (value && typeof value === 'object' ? value as Partial<ControlPlaneDeviceAccountsResponse['result']> : null);
  const accounts = Array.isArray(result?.accounts) ? result.accounts : [];
  return {
    accounts: accounts.map((account) => {
      const source = account && typeof account === 'object'
        ? account as Partial<ControlPlaneDeviceAccountsResponse['result']['accounts'][number]>
        : {};
      return {
        accountRef: normalizeText(source.accountRef, 96),
        provider: normalizeControlPlaneProvider(source.provider),
        label: normalizeText(source.label, 160),
        status: source.status === 'down' ? 'down' as const : 'up' as const,
        authMode: source.authMode === 'api-key' ? 'api-key' as const : 'oauth' as const,
        planType: normalizeText(source.planType, 64),
        runtimeStatus: normalizeText(source.runtimeStatus, 64),
        quotaStatus: normalizeText(source.quotaStatus, 64),
        schedulableStatus: normalizeText(source.schedulableStatus, 64),
        remainingPct: normalizePercent(source.remainingPct),
        modelCooldownCount: normalizeCount(source.modelCooldownCount),
        lastRefresh: normalizeCount(source.lastRefresh),
        successCount: normalizeCount(source.successCount),
        failCount: normalizeCount(source.failCount)
      };
    }).filter((account) => Boolean(account.accountRef)),
    summary: normalizeDeviceAccountSummary(result?.summary)
  };
}

function normalizeDeviceSessionStatus(value: unknown) {
  const status = normalizeText(value, 32).toLowerCase();
  if (['idle', 'running', 'draft', 'failed'].includes(status)) {
    return status as ControlPlaneDeviceSessionsResponse['result']['sessions'][number]['status'];
  }
  return 'idle';
}

function normalizeDeviceSessionItem(value: unknown): ControlPlaneDeviceSessionsResponse['result']['sessions'][number] | null {
  const source = value && typeof value === 'object'
    ? value as Partial<ControlPlaneDeviceSessionsResponse['result']['sessions'][number]>
    : {};
  const session = {
    sessionRef: normalizeText(source.sessionRef, 96),
    projectRef: normalizeText(source.projectRef, 96),
    provider: normalizeControlPlaneProvider(source.provider),
    title: normalizeText(source.title, 160),
    projectName: normalizeText(source.projectName, 120),
    status: normalizeDeviceSessionStatus(source.status),
    updatedAt: Math.max(0, Number(source.updatedAt) || 0),
    startedAt: Math.max(0, Number(source.startedAt) || 0)
  };
  return session.sessionRef && session.projectRef ? session : null;
}

export function normalizeDeviceSessions(value: unknown) {
  const payload = value && typeof value === 'object' ? value as Partial<ControlPlaneDeviceSessionsResponse> : null;
  const result = payload?.result && typeof payload.result === 'object'
    ? payload.result as Partial<ControlPlaneDeviceSessionsResponse['result']>
    : (value && typeof value === 'object' ? value as Partial<ControlPlaneDeviceSessionsResponse['result']> : null);
  const sessions = Array.isArray(result?.sessions) ? result.sessions : [];
  return {
    sessions: sessions
      .map(normalizeDeviceSessionItem)
      .filter((session): session is ControlPlaneDeviceSessionsResponse['result']['sessions'][number] => Boolean(session)),
    summary: normalizeDeviceSessionSummary(result?.summary)
  };
}

function normalizeDeviceSessionMessageSummary(value: unknown): ControlPlaneDeviceSessionMessagesSummary {
  const source = value && typeof value === 'object' ? value as Partial<ControlPlaneDeviceSessionMessagesSummary> : {};
  return {
    total: normalizeCount(source.total),
    returned: normalizeCount(source.returned),
    truncated: Boolean(source.truncated),
    cursor: Math.max(0, Number(source.cursor) || 0)
  };
}

export function normalizeDeviceSessionMessages(value: unknown) {
  const payload = value && typeof value === 'object' ? value as Partial<ControlPlaneDeviceSessionMessagesResponse> : null;
  const result = payload?.result && typeof payload.result === 'object'
    ? payload.result as Partial<ControlPlaneDeviceSessionMessagesResponse['result']>
    : (value && typeof value === 'object' ? value as Partial<ControlPlaneDeviceSessionMessagesResponse['result']> : null);
  const session = normalizeDeviceSessionItem(result?.session);
  if (!session) {
    throw new Error('invalid_control_plane_device_session_messages');
  }
  const messages = Array.isArray(result?.messages) ? result.messages : [];
  return {
    session,
    messages: messages.map((message) => {
      const source = message && typeof message === 'object'
        ? message as Partial<ControlPlaneDeviceSessionMessagesResponse['result']['messages'][number]>
        : {};
      const role = source.role === 'assistant' || source.role === 'user' ? source.role : null;
      const content = normalizeText(source.content, 12000);
      if (!role || !content) return null;
      const timestamp = typeof source.timestamp === 'number'
        ? Math.max(0, Number(source.timestamp) || 0)
        : normalizeText(source.timestamp, 128);
      return {
        role,
        content,
        timestamp
      };
    }).filter((message): message is { role: 'user' | 'assistant'; content: string; timestamp: string | number } => Boolean(message)),
    summary: normalizeDeviceSessionMessageSummary(result?.summary)
  };
}

export function normalizeDeviceNodeSessionMessages(value: unknown) {
  const source = value && typeof value === 'object'
    ? value as Partial<ControlPlaneDeviceNodeSessionMessagesResponse>
    : null;
  if (!source || source.rpc !== 'control_plane.device.node_session_messages') {
    throw new Error('invalid_control_plane_device_node_session_messages');
  }
  const nodeId = normalizeText(source.nodeId, 96);
  if (!nodeId) {
    throw new Error('invalid_control_plane_device_node_session_messages');
  }
  return {
    nodeId,
    ...normalizeDeviceSessionMessages({
      ok: Boolean(source.ok),
      rpc: 'control_plane.device.session_messages',
      result: source.result
    })
  };
}

export function normalizeDeviceNodeSessions(value: unknown) {
  const source = value && typeof value === 'object'
    ? value as Partial<ControlPlaneDeviceNodeSessionsResponse>
    : null;
  if (!source || source.rpc !== 'control_plane.device.node_sessions') {
    throw new Error('invalid_control_plane_device_node_sessions');
  }
  const nodeId = normalizeText(source.nodeId, 96);
  if (!nodeId) {
    throw new Error('invalid_control_plane_device_node_sessions');
  }
  return {
    nodeId,
    ...normalizeDeviceSessions({
      ok: Boolean(source.ok),
      rpc: 'control_plane.device.sessions',
      result: source.result
    })
  };
}

export function normalizeDeviceNodeSessionInput(value: unknown) {
  const source = value && typeof value === 'object'
    ? value as Partial<ControlPlaneDeviceNodeSessionInputResponse>
    : null;
  if (!source || source.rpc !== 'control_plane.device.node_session_input') {
    throw new Error('invalid_control_plane_device_node_session_input');
  }
  const nodeId = normalizeText(source.nodeId, 96);
  const result = source.result && typeof source.result === 'object' ? source.result : null;
  const session = result ? normalizeDeviceSessionItem(result.session) : null;
  if (!nodeId || !result || !session || result.accepted !== true) {
    throw new Error('invalid_control_plane_device_node_session_input');
  }
  return {
    nodeId,
    session,
    accepted: true,
    appendNewline: result.appendNewline !== false,
    promptId: normalizeText(result.promptId, 256)
  };
}

function normalizeDeviceSessionEvent(value: unknown): ControlPlaneDeviceSessionEvent | null {
  const source = value && typeof value === 'object'
    ? value as Partial<ControlPlaneDeviceSessionEvent>
    : {};
  const type = normalizeText(source.type, 64);
  const timestamp = normalizeText(source.timestamp, 128);
  if (type === 'user_message') {
    const content = normalizeText((source as { content?: unknown }).content, 12000);
    return content ? { type, timestamp, content } : null;
  }
  if (type === 'assistant_text' || type === 'assistant_reasoning') {
    const text = normalizeText((source as { text?: unknown }).text, 12000);
    return text ? { type, timestamp, text } : null;
  }
  return null;
}

export function normalizeDeviceSessionEvents(value: unknown) {
  const payload = value && typeof value === 'object' ? value as Partial<ControlPlaneDeviceSessionEventsResponse> : null;
  const result = payload?.result && typeof payload.result === 'object'
    ? payload.result as Partial<ControlPlaneDeviceSessionEventsResponse['result']>
    : (value && typeof value === 'object' ? value as Partial<ControlPlaneDeviceSessionEventsResponse['result']> : null);
  const session = normalizeDeviceSessionItem(result?.session);
  if (!session) {
    throw new Error('invalid_control_plane_device_session_events');
  }
  const events = Array.isArray(result?.events) ? result.events : [];
  return {
    session,
    events: events
      .map(normalizeDeviceSessionEvent)
      .filter((event): event is ControlPlaneDeviceSessionEvent => Boolean(event)),
    cursor: Math.max(0, Number(result?.cursor) || 0),
    requiresSnapshot: Boolean(result?.requiresSnapshot),
    truncated: Boolean(result?.truncated)
  };
}

export function normalizeDeviceSessionStreamFrame(value: unknown) {
  const source = value && typeof value === 'object'
    ? value as Partial<ControlPlaneDeviceSessionStreamFrame>
    : null;
  if (!source || source.rpc !== 'control_plane.device.session_stream' || source.type !== 'events') {
    return null;
  }
  return normalizeDeviceSessionEvents({
    ok: Boolean(source.ok),
    rpc: 'control_plane.device.session_events',
    result: source.result
  });
}

export function normalizeDeviceNodeSessionStreamFrame(value: unknown) {
  const source = value && typeof value === 'object'
    ? value as Partial<ControlPlaneDeviceNodeSessionStreamFrame>
    : null;
  if (!source || source.rpc !== 'control_plane.device.node_session_stream' || source.type !== 'events') {
    return null;
  }
  const nodeId = normalizeText(source.nodeId, 96);
  if (!nodeId) return null;
  return {
    nodeId,
    ...normalizeDeviceSessionEvents({
      ok: Boolean(source.ok),
      rpc: 'control_plane.device.session_events',
      result: source.result
    })
  };
}

function normalizeRemoteTransportKind(value: unknown) {
  const kind = normalizeText(value, 64).toLowerCase();
  if ([
    'direct',
    'frp',
    'ssh',
    'tailscale',
    'zerotier',
    'wireguard',
    'omr',
    'mptcp',
    'relay'
  ].includes(kind)) {
    return kind as ControlPlaneNodeSummary['preferredTransports'][number];
  }
  return 'direct';
}

function normalizeRemoteTransportRouteRole(value: unknown) {
  const role = normalizeText(value, 64).toLowerCase();
  if (['data-plane', 'bootstrap', 'underlay'].includes(role)) {
    return role as ControlPlaneNodeSummary['transports'][number]['routeRole'];
  }
  return 'data-plane';
}

function normalizeRemoteTransportTrustLevel(value: unknown) {
  const trustLevel = normalizeText(value, 64).toLowerCase();
  if (['managed', 'verified', 'external', 'manual'].includes(trustLevel)) {
    return trustLevel as ControlPlaneNodeSummary['transports'][number]['trustLevel'];
  }
  return 'manual';
}

function normalizeRemoteNodeConnection(value: unknown): ControlPlaneNodeSummary['connection'] {
  const source = value && typeof value === 'object'
    ? value as Partial<ControlPlaneNodeSummary['connection']>
    : {};
  const status = normalizeText(source.status, 32).toLowerCase();
  return {
    status: status === 'online' || status === 'offline' ? status : 'unknown',
    transportKind: source.transportKind ? normalizeRemoteTransportKind(source.transportKind) : '',
    transportId: normalizeText(source.transportId, 96),
    sessionId: normalizeText(source.sessionId, 128),
    remoteAddress: normalizeText(source.remoteAddress, 256),
    connectedAt: Math.max(0, Number(source.connectedAt) || 0),
    lastSeenAt: Math.max(0, Number(source.lastSeenAt) || 0)
  };
}

function normalizeNodeSummary(value: unknown): ControlPlaneNodeSummary | null {
  const source = value && typeof value === 'object' ? value as Partial<ControlPlaneNodeSummary> : null;
  if (!source) return null;
  const id = normalizeText(source.id, 96);
  if (!id) return null;
  const transports = Array.isArray(source.transports) ? source.transports : [];
  return {
    id,
    name: normalizeText(source.name, 120) || id,
    role: normalizeText(source.role, 64),
    endpointPolicy: normalizeText(source.endpointPolicy, 32),
    preferredTransports: normalizeStringArray(source.preferredTransports)
      .map(normalizeRemoteTransportKind),
    capabilities: normalizeStringArray(source.capabilities),
    fingerprint: normalizeText(source.fingerprint, 160),
    tags: normalizeStringArray(source.tags),
    disabled: Boolean(source.disabled),
    lastSeenAt: Math.max(0, Number(source.lastSeenAt) || 0),
    connection: normalizeRemoteNodeConnection(source.connection),
    createdAt: Math.max(0, Number(source.createdAt) || 0),
    updatedAt: Math.max(0, Number(source.updatedAt) || 0),
    transports: transports.map((transport) => {
      const item = transport && typeof transport === 'object'
        ? transport as ControlPlaneNodeSummary['transports'][number]
        : {} as ControlPlaneNodeSummary['transports'][number];
      return {
        id: normalizeText(item.id, 96),
        nodeId: normalizeText(item.nodeId, 96),
        kind: normalizeRemoteTransportKind(item.kind),
        status: normalizeText(item.status, 32),
        score: Math.max(0, Math.min(100, Number(item.score) || 0)),
        latencyMs: Math.max(0, Number(item.latencyMs) || 0),
        lastError: normalizeText(item.lastError, 512),
        disabled: Boolean(item.disabled),
        managedBy: normalizeText(item.managedBy, 64),
        provider: normalizeText(item.provider, 64),
        routeRole: normalizeRemoteTransportRouteRole(item.routeRole),
        trustLevel: normalizeRemoteTransportTrustLevel(item.trustLevel),
        createdAt: Math.max(0, Number(item.createdAt) || 0),
        updatedAt: Math.max(0, Number(item.updatedAt) || 0)
      };
    }).filter((transport) => Boolean(transport.id))
  };
}

export function normalizeDeviceNodes(value: unknown): ControlPlaneNodeSummary[] {
  const payload = value && typeof value === 'object' ? value as Partial<ControlPlaneDeviceNodesResponse> : null;
  const nodes = payload?.result && typeof payload.result === 'object'
    ? (payload.result as { nodes?: unknown }).nodes
    : (value && typeof value === 'object' ? (value as { nodes?: unknown }).nodes : null);
  return (Array.isArray(nodes) ? nodes : [])
    .map(normalizeNodeSummary)
    .filter((node): node is ControlPlaneNodeSummary => Boolean(node));
}

export function normalizeProfileNodes(value: unknown): ControlPlaneNodeSummary[] {
  const nodes = Array.isArray(value) ? value : [];
  return nodes
    .map(normalizeNodeSummary)
    .filter((node): node is ControlPlaneNodeSummary => Boolean(node))
    .slice(0, MAX_PROFILE_NODE_CACHE);
}

export function normalizeProfile(value: unknown): ControlPlaneProfile | null {
  const source = value && typeof value === 'object' ? value as Partial<ControlPlaneProfile> : null;
  if (!source) return null;
  const legacyEndpoint = normalizeControlPlaneEndpoint(String(source.endpoint || ''));
  const now = Date.now();
  const descriptor = normalizeAnyDescriptor(source.descriptor);
  const id = normalizeText(source.id, 96) || stableProfileId(legacyEndpoint);
  const managementKey = isNativeDesktopRuntime()
    ? ''
    : normalizeText(source.managementKey, 4096);
  const credentialRef = normalizeText(source.credentialRef, 256);
  const managementKeyConfigured = Boolean(
    source.managementKeyConfigured === true || managementKey
  );
  const state = inferProfileState({
    requestedState: source.state,
    managementKey,
    managementKeyConfigured,
    existing: source
  });
  const nodes = normalizeProfileNodes(source.nodes);
  const connectionMode = normalizeProfileConnectionMode(source.connectionMode, legacyEndpoint);
  const broker = connectionMode === 'broker-proxy'
    ? normalizeProfileBroker(source.broker, legacyEndpoint)
    : null;
  const stableServerId = normalizeStableServerId(
    source.stableServerId || broker?.serverId,
    legacyEndpoint
  );
  const routes = migrateLegacyServerRoutes({
    endpoint: legacyEndpoint,
    connectionMode,
    broker,
    state,
    routes: source.routes
  });
  const activeRoute = selectProfileRoute(routes, source.activeRouteId, legacyEndpoint);
  const endpoint = activeRoute?.endpoint || legacyEndpoint;
  if (!endpoint || !stableServerId) return null;
  return {
    id,
    stableServerId,
    name: normalizeText(source.name, 120) || descriptor?.endpoint || endpoint,
    endpoint,
    routes,
    activeRouteId: activeRoute?.id || '',
    authorizationState: resolveServerAuthorizationState(managementKeyConfigured),
    connectionMode,
    broker,
    state,
    managementKey,
    credentialRef,
    managementKeyConfigured,
    nodes,
    nodeCount: Math.max(nodes.length, Number(source.nodeCount) || 0),
    accountCount: Math.max(0, Number(source.accountCount) || 0),
    activeAccountCount: Math.max(0, Number(source.activeAccountCount) || 0),
    schedulableAccountCount: Math.max(0, Number(source.schedulableAccountCount) || 0),
    sessionCount: Math.max(0, Number(source.sessionCount) || 0),
    lastNodeSyncAt: Math.max(0, Number(source.lastNodeSyncAt) || 0),
    lastStatusSyncAt: Math.max(0, Number(source.lastStatusSyncAt) || 0),
    lastAccountsSyncAt: Math.max(0, Number(source.lastAccountsSyncAt) || 0),
    lastSessionsSyncAt: Math.max(0, Number(source.lastSessionsSyncAt) || 0),
    descriptor,
    lastCheckedAt: Math.max(0, Number(source.lastCheckedAt) || 0),
    lastError: normalizeText(source.lastError, 512),
    createdAt: Math.max(0, Number(source.createdAt) || now),
    updatedAt: Math.max(0, Number(source.updatedAt) || now)
  };
}