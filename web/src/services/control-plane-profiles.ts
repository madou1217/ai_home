import type {
  ControlPlaneDescriptor,
  ControlPlaneDescriptorResponse,
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
  ControlPlaneDevicePairResponse,
  ControlPlaneDeviceProfileResponse,
  ControlPlaneDeviceStatus,
  ControlPlaneDeviceStatusResponse,
  ControlPlaneNodeSummary,
  ControlPlaneProfileBundle,
  ControlPlaneProfileBundleEntry,
  ControlPlaneProfileBroker,
  ControlPlaneProfileConnectionMode,
  ControlPlaneProfileState,
  ControlPlaneProfile
} from '@/types';
import type {
  ControlPlaneEventStreamFetch,
  ControlPlaneEventStreamRequest
} from './control-plane-api-client';
import {
  buildControlPlaneHttpUrl,
  consumeControlPlaneEventStream,
  createControlPlaneApiClient,
  normalizeControlPlaneEndpoint
} from './control-plane-api-client';

export { normalizeControlPlaneEndpoint };

const STORAGE_KEY = 'aih:control-plane-profiles:v1';
export const CONTROL_PLANE_PROFILES_CHANGED_EVENT = 'aih:control-plane-profiles-changed';
const SHARED_PROFILE_API_PATH = '/v0/webui/control-plane/profiles';
const DEFAULT_DESCRIPTOR_TIMEOUT_MS = 8000;
const DEFAULT_DEVICE_REQUEST_TIMEOUT_MS = 10000;
const DEFAULT_PAIR_REQUEST_TIMEOUT_MS = 10000;
const MAX_PROFILE_NODE_CACHE = 100;
const CURRENT_CONTROL_PLANE_PROFILE_NAME = '当前 Control Plane';
const CONTROL_PLANE_PROFILE_BUNDLE_KIND = 'aih-control-plane-profile-bundle';
const CONTROL_PLANE_PROFILE_BUNDLE_VERSION = 1;
const PROFILE_BUNDLE_SECRET_KEYS = new Set([
  'apikey',
  'authorization',
  'clientkey',
  'devicetoken',
  'managementkey',
  'refreshtoken',
  'secret',
  'token'
]);
export const CONTROL_PLANE_PROFILE_STATES: ControlPlaneProfileState[] = [
  'draft',
  'discovered',
  'pairing',
  'paired',
  'degraded',
  'revoked',
  'recovery'
];
export const CONTROL_PLANE_PROFILE_CONNECTION_MODES: ControlPlaneProfileConnectionMode[] = [
  'direct',
  'broker-proxy'
];

interface StorageLike {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

interface SharedControlPlaneProfilesResponse {
  ok?: boolean;
  profiles?: unknown;
  profile?: unknown;
  activeProfileId?: unknown;
}

export interface ControlPlaneProfilesChangeDetail {
  profileIds: string[];
  previousProfileIds: string[];
}

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

function getStorage(): StorageLike | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage || null;
}

function getEventTarget(): EventTarget | null {
  if (typeof window === 'undefined') return null;
  if (typeof window.addEventListener !== 'function' || typeof window.dispatchEvent !== 'function') return null;
  return window;
}

function getSharedProfileFetch(): typeof fetch | null {
  if (typeof window === 'undefined') return null;
  const fetcher = (window as Window & { fetch?: typeof fetch }).fetch;
  return typeof fetcher === 'function' ? fetcher.bind(window) : null;
}

function normalizeText(value: unknown, maxLength = 512) {
  const text = String(value ?? '').trim();
  return text.length > maxLength ? text.slice(0, maxLength) : text;
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

function normalizeProfileConnectionMode(value: unknown, endpoint = ''): ControlPlaneProfileConnectionMode {
  const mode = normalizeText(value, 32).toLowerCase();
  if (CONTROL_PLANE_PROFILE_CONNECTION_MODES.includes(mode as ControlPlaneProfileConnectionMode)) {
    return mode as ControlPlaneProfileConnectionMode;
  }
  return parseFabricBrokerProxyEndpoint(endpoint) ? 'broker-proxy' : 'direct';
}

function normalizeProfileBroker(value: unknown, endpoint = ''): ControlPlaneProfileBroker | null {
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

function shouldForcePairEndpoint(input: {
  connectionMode?: ControlPlaneProfileConnectionMode;
  broker?: ControlPlaneProfileBroker | null;
}) {
  return input.connectionMode === 'broker-proxy' || Boolean(input.broker);
}

function getCurrentWebUiControlPlaneEndpoint() {
  if (typeof window === 'undefined') return '';
  const origin = normalizeText(window.location?.origin, 512);
  if (!/^https?:\/\//i.test(origin)) return '';
  return normalizeControlPlaneEndpoint(origin);
}

export function normalizeControlPlaneProfileState(
  value: unknown,
  fallback: ControlPlaneProfileState = 'draft'
): ControlPlaneProfileState {
  const state = normalizeText(value, 64).toLowerCase() as ControlPlaneProfileState;
  return CONTROL_PLANE_PROFILE_STATES.includes(state) ? state : fallback;
}

function normalizeControlPlaneAuthState(value: unknown) {
  const state = normalizeText(value, 32).toLowerCase();
  if (state === 'paired' || state === 'unpaired' || state === 'unknown') return state;
  return 'unknown';
}

function inferProfileState(input: {
  requestedState?: unknown;
  requestedAuthState?: unknown;
  existing?: Partial<ControlPlaneProfile> | null;
  descriptor?: ControlPlaneDescriptor | null;
  lastError?: string;
}): ControlPlaneProfileState {
  const explicitState = normalizeText(input.requestedState, 64).toLowerCase();
  if (CONTROL_PLANE_PROFILE_STATES.includes(explicitState as ControlPlaneProfileState)) {
    return explicitState as ControlPlaneProfileState;
  }
  if (input.lastError) return 'degraded';
  const requestedAuthState = normalizeControlPlaneAuthState(input.requestedAuthState);
  const existingState = normalizeControlPlaneProfileState(input.existing?.state, 'draft');
  const existingAuthState = normalizeControlPlaneAuthState(input.existing?.authState);
  if (requestedAuthState === 'paired' || existingAuthState === 'paired') {
    return input.descriptor ? 'paired' : existingState === 'degraded' ? 'degraded' : 'paired';
  }
  if (input.descriptor) return 'discovered';
  if (existingState !== 'draft') return existingState;
  return requestedAuthState === 'unpaired' ? 'draft' : existingState;
}

function inferAuthState(state: ControlPlaneProfileState, requested: unknown, existing?: Partial<ControlPlaneProfile> | null) {
  const requestedState = normalizeControlPlaneAuthState(requested);
  if (requestedState !== 'unknown') return requestedState;
  const existingState = normalizeControlPlaneAuthState(existing?.authState);
  if (existingState !== 'unknown') return existingState;
  return state === 'paired' ? 'paired' : 'unpaired';
}

export function buildControlPlaneDescriptorUrl(endpoint: string): string {
  return buildControlPlaneHttpUrl(endpoint, '/v0/node-rpc/descriptor');
}

function stableProfileId(endpoint: string) {
  let hash = 2166136261;
  for (const char of endpoint) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `cp-${(hash >>> 0).toString(36)}`;
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
      managementKeyConfigured: Boolean(auth.managementKeyConfigured),
      clientKeyConfigured: Boolean(auth.clientKeyConfigured)
    },
    capabilities: {
      nodeRpc: Array.isArray(capabilities.nodeRpc) ? capabilities.nodeRpc.map(String).filter(Boolean) : [],
      management: Array.isArray(capabilities.management) ? capabilities.management.map(String).filter(Boolean) : [],
      remoteManagement: Boolean(capabilities.remoteManagement),
      remoteInvite: Boolean(capabilities.remoteInvite),
      devicePairing: Boolean(capabilities.devicePairing),
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
      managementKeyConfigured: Boolean(auth.managementKeyConfigured),
      clientKeyConfigured: Boolean(auth.clientKeyConfigured)
    },
    capabilities: {
      nodeRpc: Array.isArray(legacy.nodeRpc) ? legacy.nodeRpc.map(String).filter(Boolean) : [],
      management: Array.isArray(legacy.management) ? legacy.management.map(String).filter(Boolean) : [],
      remoteManagement: true,
      remoteInvite: true,
      devicePairing: Boolean(auth.devicePairing),
      transports: Array.isArray(capabilities.transports) ? capabilities.transports.map(String).filter(Boolean) : []
    }
  };
}

function normalizeAnyDescriptor(value: unknown): ControlPlaneDescriptor | null {
  return normalizeFabricDescriptor(value) || normalizeDescriptor(value);
}

function normalizeStringArray(value: unknown) {
  return Array.isArray(value) ? value.map((item) => normalizeText(item, 96)).filter(Boolean) : [];
}

function hasProfileBundleSecretKey(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(hasProfileBundleSecretKey);
  return Object.keys(value as Record<string, unknown>).some((key) => {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (PROFILE_BUNDLE_SECRET_KEYS.has(normalizedKey)) return true;
    return hasProfileBundleSecretKey((value as Record<string, unknown>)[key]);
  });
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

function normalizeDeviceStatus(value: unknown): ControlPlaneDeviceStatus | null {
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
  if (['codex', 'gemini', 'claude', 'agy', 'opencode'].includes(provider)) {
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

function normalizeDeviceAccounts(value: unknown) {
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

function normalizeDeviceSessions(value: unknown) {
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

function normalizeDeviceSessionMessages(value: unknown) {
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

function normalizeDeviceNodeSessionMessages(value: unknown) {
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

function normalizeDeviceNodeSessions(value: unknown) {
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

function normalizeDeviceNodeSessionInput(value: unknown) {
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

function normalizeDeviceSessionEvents(value: unknown) {
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

function normalizeDeviceSessionStreamFrame(value: unknown) {
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

function normalizeDeviceNodeSessionStreamFrame(value: unknown) {
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

function normalizeDeviceNodes(value: unknown): ControlPlaneNodeSummary[] {
  const payload = value && typeof value === 'object' ? value as Partial<ControlPlaneDeviceNodesResponse> : null;
  const nodes = payload?.result && typeof payload.result === 'object'
    ? (payload.result as { nodes?: unknown }).nodes
    : (value && typeof value === 'object' ? (value as { nodes?: unknown }).nodes : null);
  return (Array.isArray(nodes) ? nodes : [])
    .map(normalizeNodeSummary)
    .filter((node): node is ControlPlaneNodeSummary => Boolean(node));
}

function normalizeProfileNodes(value: unknown): ControlPlaneNodeSummary[] {
  const nodes = Array.isArray(value) ? value : [];
  return nodes
    .map(normalizeNodeSummary)
    .filter((node): node is ControlPlaneNodeSummary => Boolean(node))
    .slice(0, MAX_PROFILE_NODE_CACHE);
}

function normalizeDeviceProfile(value: unknown) {
  const payload = value && typeof value === 'object' ? value as Partial<ControlPlaneDeviceProfileResponse> : null;
  const result = payload?.result && typeof payload.result === 'object'
    ? payload.result as ControlPlaneDeviceProfileResponse['result'] & { fabric?: unknown }
    : null;
  const descriptor = normalizeAnyDescriptor(result?.fabric) || normalizeDescriptor(result?.controlPlane);
  const device = result?.device && typeof result.device === 'object' ? result.device : null;
  if (!descriptor || !device) return null;
  return {
    descriptor,
    device: {
      ...device,
      id: normalizeText(device.id, 96),
      name: normalizeText(device.name, 120),
      platform: normalizeText(device.platform, 64),
      state: device.state === 'revoked' ? 'revoked' : 'paired',
      scopes: normalizeStringArray(device.scopes)
    }
  };
}

function normalizeDevicePairResponse(value: unknown): ControlPlaneDevicePairResponse | null {
  const source = value && typeof value === 'object'
    ? value as Partial<ControlPlaneDevicePairResponse> & { result?: unknown }
    : null;
  const result = source?.result && typeof source.result === 'object'
    ? source.result as { device?: unknown; token?: unknown }
    : null;
  const device = (
    result?.device && typeof result.device === 'object'
      ? result.device
      : source?.device && typeof source.device === 'object' ? source.device : null
  ) as Partial<ControlPlaneDevicePairResponse['device']> | null;
  const token = normalizeText(result?.token || source?.token, 4096);
  const rpc = String(source?.rpc || '');
  if (!source || !['control_plane.device.pair', 'fabric.device.pair'].includes(rpc) || !device || !token) return null;
  return {
    ok: Boolean(source.ok),
    rpc: 'control_plane.device.pair',
    token,
    device: {
      ...device,
      id: normalizeText(device.id, 96),
      name: normalizeText(device.name, 120),
      platform: normalizeText(device.platform, 64),
      publicKeyFingerprint: normalizeText(device.publicKeyFingerprint, 160),
      scopes: normalizeStringArray(device.scopes),
      state: device.state === 'revoked' ? 'revoked' : 'paired',
      pairedAt: Math.max(0, Number(device.pairedAt) || 0),
      revokedAt: Math.max(0, Number(device.revokedAt) || 0),
      lastSeenAt: Math.max(0, Number(device.lastSeenAt) || 0),
      createdAt: Math.max(0, Number(device.createdAt) || 0),
      updatedAt: Math.max(0, Number(device.updatedAt) || 0)
    }
  };
}

function normalizeProfile(value: unknown): ControlPlaneProfile | null {
  const source = value && typeof value === 'object' ? value as Partial<ControlPlaneProfile> : null;
  if (!source) return null;
  const endpoint = normalizeControlPlaneEndpoint(String(source.endpoint || ''));
  if (!endpoint) return null;
  const now = Date.now();
  const descriptor = normalizeAnyDescriptor(source.descriptor);
  const id = normalizeText(source.id, 96) || stableProfileId(endpoint);
  const state = inferProfileState({
    requestedState: source.state,
    requestedAuthState: source.authState,
    descriptor,
    existing: source
  });
  const nodes = normalizeProfileNodes(source.nodes);
  const connectionMode = normalizeProfileConnectionMode(source.connectionMode, endpoint);
  const broker = connectionMode === 'broker-proxy'
    ? normalizeProfileBroker(source.broker, endpoint)
    : null;
  return {
    id,
    name: normalizeText(source.name, 120) || descriptor?.endpoint || endpoint,
    endpoint,
    connectionMode,
    broker,
    state,
    authState: inferAuthState(state, source.authState, source),
    deviceToken: normalizeText(source.deviceToken, 4096),
    nodes,
    nodeCount: Math.max(nodes.length, Number(source.nodeCount) || 0),
    accountCount: Math.max(0, Number(source.accountCount) || 0),
    activeAccountCount: Math.max(0, Number(source.activeAccountCount) || 0),
    schedulableAccountCount: Math.max(0, Number(source.schedulableAccountCount) || 0),
    sessionCount: Math.max(0, Number(source.sessionCount) || 0),
    lastDeviceSyncAt: Math.max(0, Number(source.lastDeviceSyncAt) || 0),
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

function createProfileBundleEntry(profile: ControlPlaneProfile, exportedAt: string): ControlPlaneProfileBundleEntry {
  const connectionMode = normalizeProfileConnectionMode(profile.connectionMode, profile.endpoint);
  const broker = connectionMode === 'broker-proxy'
    ? normalizeProfileBroker(profile.broker, profile.endpoint)
    : null;
  return {
    name: normalizeText(profile.name, 120) || profile.endpoint,
    endpoint: normalizeControlPlaneEndpoint(profile.endpoint),
    connectionMode,
    broker,
    descriptor: normalizeAnyDescriptor(profile.descriptor),
    nodeCount: Math.max(0, Number(profile.nodeCount) || 0),
    accountCount: Math.max(0, Number(profile.accountCount) || 0),
    schedulableAccountCount: Math.max(0, Number(profile.schedulableAccountCount) || 0),
    sessionCount: Math.max(0, Number(profile.sessionCount) || 0),
    exportedAt
  };
}

function normalizeProfileBundleEntry(value: unknown): ControlPlaneProfileBundleEntry | null {
  const source = value && typeof value === 'object'
    ? value as Partial<ControlPlaneProfileBundleEntry>
    : null;
  const endpoint = normalizeControlPlaneEndpoint(source?.endpoint || '');
  if (!source || !endpoint) return null;
  const descriptor = normalizeAnyDescriptor(source.descriptor);
  const connectionMode = normalizeProfileConnectionMode(source.connectionMode, endpoint);
  const broker = connectionMode === 'broker-proxy'
    ? normalizeProfileBroker(source.broker, endpoint)
    : null;
  return {
    name: normalizeText(source.name, 120) || descriptor?.endpoint || endpoint,
    endpoint,
    connectionMode,
    broker,
    descriptor,
    nodeCount: Math.max(0, Number(source.nodeCount) || 0),
    accountCount: Math.max(0, Number(source.accountCount) || 0),
    schedulableAccountCount: Math.max(0, Number(source.schedulableAccountCount) || 0),
    sessionCount: Math.max(0, Number(source.sessionCount) || 0),
    exportedAt: normalizeText(source.exportedAt, 128)
  };
}

export function createControlPlaneProfileBundle(
  input: ControlPlaneProfile | ControlPlaneProfile[]
): ControlPlaneProfileBundle {
  const exportedAt = new Date().toISOString();
  const profiles = (Array.isArray(input) ? input : [input])
    .map((profile) => profile && createProfileBundleEntry(profile, exportedAt))
    .filter((entry): entry is ControlPlaneProfileBundleEntry => Boolean(entry && entry.endpoint));
  return {
    kind: CONTROL_PLANE_PROFILE_BUNDLE_KIND,
    version: CONTROL_PLANE_PROFILE_BUNDLE_VERSION,
    exportedAt,
    profiles,
    warnings: [
      'device_token_not_exported',
      'import_requires_pairing'
    ]
  };
}

export function serializeControlPlaneProfileBundle(input: ControlPlaneProfile | ControlPlaneProfile[]) {
  return `${JSON.stringify(createControlPlaneProfileBundle(input), null, 2)}\n`;
}

export function parseControlPlaneProfileBundle(input: string | unknown): ControlPlaneProfileBundle {
  const parsed = typeof input === 'string' ? JSON.parse(input) : input;
  if (hasProfileBundleSecretKey(parsed)) {
    throw new Error('control_plane_profile_bundle_contains_secret');
  }
  const source = parsed && typeof parsed === 'object'
    ? parsed as Partial<ControlPlaneProfileBundle>
    : null;
  if (!source || source.kind !== CONTROL_PLANE_PROFILE_BUNDLE_KIND || source.version !== CONTROL_PLANE_PROFILE_BUNDLE_VERSION) {
    throw new Error('invalid_control_plane_profile_bundle');
  }
  const profiles = (Array.isArray(source.profiles) ? source.profiles : [])
    .map(normalizeProfileBundleEntry)
    .filter((entry): entry is ControlPlaneProfileBundleEntry => Boolean(entry));
  if (profiles.length === 0) {
    throw new Error('empty_control_plane_profile_bundle');
  }
  return {
    kind: CONTROL_PLANE_PROFILE_BUNDLE_KIND,
    version: CONTROL_PLANE_PROFILE_BUNDLE_VERSION,
    exportedAt: normalizeText(source.exportedAt, 128),
    profiles,
    warnings: normalizeStringArray(source.warnings)
  };
}

export function importControlPlaneProfileBundle(input: string | unknown) {
  const bundle = parseControlPlaneProfileBundle(input);
  const before = readProfiles();
  const beforeByEndpoint = new Map(before.map((profile) => [profile.endpoint, profile]));
  const imported = bundle.profiles.map((entry) => {
    const existing = beforeByEndpoint.get(entry.endpoint) || null;
    const profile = saveControlPlaneProfile({
      name: entry.name,
      endpoint: entry.endpoint,
      connectionMode: entry.connectionMode,
      broker: entry.broker,
      descriptor: entry.descriptor,
      state: existing?.deviceToken ? existing.state : 'discovered',
      authState: existing?.deviceToken ? existing.authState : 'unpaired',
      deviceToken: existing?.deviceToken || '',
      nodeCount: existing?.deviceToken ? existing.nodeCount : entry.nodeCount,
      accountCount: existing?.deviceToken ? existing.accountCount : entry.accountCount,
      activeAccountCount: existing?.deviceToken ? existing.activeAccountCount : 0,
      schedulableAccountCount: existing?.deviceToken ? existing.schedulableAccountCount : entry.schedulableAccountCount,
      sessionCount: existing?.deviceToken ? existing.sessionCount : entry.sessionCount,
      lastError: ''
    });
    return {
      profile,
      status: existing ? 'updated' as const : 'imported' as const,
      preservedDeviceToken: Boolean(existing?.deviceToken)
    };
  });
  return {
    bundle,
    profiles: listControlPlaneProfiles(),
    imported,
    importedCount: imported.filter((item) => item.status === 'imported').length,
    updatedCount: imported.filter((item) => item.status === 'updated').length,
    preservedDeviceTokenCount: imported.filter((item) => item.preservedDeviceToken).length
  };
}

function readProfiles(storage = getStorage()): ControlPlaneProfile[] {
  if (!storage) return [];
  try {
    const parsed = JSON.parse(storage.getItem(STORAGE_KEY) || '[]');
    return (Array.isArray(parsed) ? parsed : [])
      .map(normalizeProfile)
      .filter((item): item is ControlPlaneProfile => Boolean(item))
      .sort((left, right) => right.updatedAt - left.updatedAt || left.name.localeCompare(right.name));
  } catch (_error) {
    return [];
  }
}

function isReadyProfileCandidate(profile: ControlPlaneProfile | null | undefined) {
  return Boolean(
    profile
      && profile.authState === 'paired'
      && profile.state !== 'degraded'
      && profile.state !== 'revoked'
      && normalizeText(profile.deviceToken, 4096)
  );
}

function isAutoCurrentControlPlaneProfile(profile: ControlPlaneProfile | null | undefined) {
  const currentEndpoint = getCurrentWebUiControlPlaneEndpoint();
  return Boolean(
    profile
      && currentEndpoint
      && profile.endpoint === currentEndpoint
      && profile.name === CURRENT_CONTROL_PLANE_PROFILE_NAME
      && profile.authState !== 'paired'
      && !normalizeText(profile.deviceToken, 4096)
  );
}

function chooseProfileForMerge(left: ControlPlaneProfile | null, right: ControlPlaneProfile | null) {
  if (!left) return right;
  if (!right) return left;
  const leftReady = isReadyProfileCandidate(left);
  const rightReady = isReadyProfileCandidate(right);
  if (rightReady && !leftReady) return right;
  if (leftReady && !rightReady) return left;
  return right.updatedAt >= left.updatedAt ? right : left;
}

function mergeControlPlaneProfiles(
  localProfiles: ControlPlaneProfile[],
  sharedProfiles: ControlPlaneProfile[]
): ControlPlaneProfile[] {
  const byEndpoint = new Map<string, ControlPlaneProfile>();
  localProfiles.forEach((profile) => {
    byEndpoint.set(profile.endpoint, chooseProfileForMerge(byEndpoint.get(profile.endpoint) || null, profile) as ControlPlaneProfile);
  });
  sharedProfiles.forEach((profile) => {
    byEndpoint.set(profile.endpoint, chooseProfileForMerge(byEndpoint.get(profile.endpoint) || null, profile) as ControlPlaneProfile);
  });
  const merged = Array.from(byEndpoint.values());
  const currentEndpoint = getCurrentWebUiControlPlaneEndpoint();
  const hasReadyProfile = merged.some(isReadyProfileCandidate);
  return merged
    .filter((profile) => {
      if (!hasReadyProfile || !currentEndpoint) return true;
      if (profile.endpoint !== currentEndpoint) return true;
      return isReadyProfileCandidate(profile);
    })
    .sort((left, right) => right.updatedAt - left.updatedAt || left.name.localeCompare(right.name));
}

function normalizeSharedProfilesPayload(payload: SharedControlPlaneProfilesResponse) {
  const profiles = (Array.isArray(payload.profiles) ? payload.profiles : [])
    .map(normalizeProfile)
    .filter((profile): profile is ControlPlaneProfile => Boolean(profile));
  const activeProfileId = normalizeText(payload.activeProfileId, 96);
  return { profiles, activeProfileId };
}

async function readSharedControlPlaneProfiles(options: { fetchImpl?: typeof fetch } = {}) {
  const fetcher = options.fetchImpl || getSharedProfileFetch();
  if (!fetcher) return { profiles: [], activeProfileId: '' };
  const response = await fetcher(SHARED_PROFILE_API_PATH, {
    method: 'GET',
    headers: { accept: 'application/json' },
    credentials: 'same-origin'
  });
  if (!response.ok) {
    throw new Error(`shared_control_plane_profiles_http_${response.status}`);
  }
  return normalizeSharedProfilesPayload(await response.json() as SharedControlPlaneProfilesResponse);
}

function persistSharedControlPlaneProfile(
  profile: ControlPlaneProfile,
  options: { active?: boolean; fetchImpl?: typeof fetch } = {}
) {
  const fetcher = options.fetchImpl || getSharedProfileFetch();
  if (!fetcher || !profile) return;
  if (isAutoCurrentControlPlaneProfile(profile)) return;
  fetcher(SHARED_PROFILE_API_PATH, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json'
    },
    credentials: 'same-origin',
    body: JSON.stringify({
      profile,
      active: options.active === true
    })
  }).catch(() => {});
}

function removeSharedControlPlaneProfile(profileId: string, options: { fetchImpl?: typeof fetch } = {}) {
  const fetcher = options.fetchImpl || getSharedProfileFetch();
  const id = normalizeText(profileId, 96);
  if (!fetcher || !id) return;
  fetcher(`${SHARED_PROFILE_API_PATH}/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { accept: 'application/json' },
    credentials: 'same-origin'
  }).catch(() => {});
}

export async function syncSharedControlPlaneProfiles(options: { fetchImpl?: typeof fetch } = {}) {
  const shared = await readSharedControlPlaneProfiles(options);
  const local = readProfiles();
  const merged = mergeControlPlaneProfiles(local, shared.profiles);
  if (JSON.stringify(merged) !== JSON.stringify(local)) {
    writeProfiles(merged);
  }
  local
    .filter(isReadyProfileCandidate)
    .forEach((profile) => persistSharedControlPlaneProfile(profile, { fetchImpl: options.fetchImpl }));
  if (merged.some(isReadyProfileCandidate)) {
    shared.profiles
      .filter(isAutoCurrentControlPlaneProfile)
      .forEach((profile) => removeSharedControlPlaneProfile(profile.id, { fetchImpl: options.fetchImpl }));
  }
  return {
    profiles: merged,
    activeProfileId: shared.activeProfileId
  };
}

function parseProfileIdsFromStorageValue(value: string | null): string[] {
  try {
    const parsed = JSON.parse(value || '[]');
    return (Array.isArray(parsed) ? parsed : [])
      .map((item) => normalizeText((item as { id?: unknown })?.id, 96))
      .filter(Boolean);
  } catch (_error) {
    return [];
  }
}

function createControlPlaneProfilesChangeEvent(detail: ControlPlaneProfilesChangeDetail) {
  if (typeof CustomEvent === 'function') {
    return new CustomEvent<ControlPlaneProfilesChangeDetail>(CONTROL_PLANE_PROFILES_CHANGED_EVENT, { detail });
  }
  const event = new Event(CONTROL_PLANE_PROFILES_CHANGED_EVENT);
  Object.defineProperty(event, 'detail', {
    value: detail,
    enumerable: true
  });
  return event as CustomEvent<ControlPlaneProfilesChangeDetail>;
}

function emitControlPlaneProfilesChange(
  detail: ControlPlaneProfilesChangeDetail,
  eventTarget = getEventTarget()
) {
  if (!eventTarget || typeof eventTarget.dispatchEvent !== 'function') return;
  eventTarget.dispatchEvent(createControlPlaneProfilesChangeEvent(detail));
}

export function addControlPlaneProfilesChangeListener(
  listener: (detail: ControlPlaneProfilesChangeDetail) => void,
  eventTarget = getEventTarget()
) {
  if (!eventTarget || typeof eventTarget.addEventListener !== 'function'
    || typeof eventTarget.removeEventListener !== 'function') return () => {};
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<ControlPlaneProfilesChangeDetail>).detail || {
      profileIds: [],
      previousProfileIds: []
    };
    listener({
      profileIds: Array.isArray(detail.profileIds)
        ? detail.profileIds.map((id) => normalizeText(id, 96)).filter(Boolean)
        : [],
      previousProfileIds: Array.isArray(detail.previousProfileIds)
        ? detail.previousProfileIds.map((id) => normalizeText(id, 96)).filter(Boolean)
        : []
    });
  };
  const storageHandler = (event: Event) => {
    const storageEvent = event as StorageEvent;
    if (storageEvent.key !== STORAGE_KEY) return;
    listener({
      profileIds: parseProfileIdsFromStorageValue(storageEvent.newValue),
      previousProfileIds: parseProfileIdsFromStorageValue(storageEvent.oldValue)
    });
  };
  eventTarget.addEventListener(CONTROL_PLANE_PROFILES_CHANGED_EVENT, handler);
  eventTarget.addEventListener('storage', storageHandler);
  return () => {
    eventTarget.removeEventListener(CONTROL_PLANE_PROFILES_CHANGED_EVENT, handler);
    eventTarget.removeEventListener('storage', storageHandler);
  };
}

function writeProfiles(profiles: ControlPlaneProfile[], storage = getStorage(), eventTarget = getEventTarget()) {
  if (!storage) return;
  const previousProfileIds = parseProfileIdsFromStorageValue(storage.getItem(STORAGE_KEY));
  if (profiles.length === 0) {
    storage.removeItem(STORAGE_KEY);
    emitControlPlaneProfilesChange({ profileIds: [], previousProfileIds }, eventTarget);
    return;
  }
  storage.setItem(STORAGE_KEY, JSON.stringify(profiles));
  emitControlPlaneProfilesChange({
    profileIds: profiles.map((profile) => profile.id),
    previousProfileIds
  }, eventTarget);
}

export function listControlPlaneProfiles(): ControlPlaneProfile[] {
  ensureCurrentControlPlaneProfile();
  return readProfiles();
}

export function ensureCurrentControlPlaneProfile(): ControlPlaneProfile | null {
  const endpoint = getCurrentWebUiControlPlaneEndpoint();
  if (!endpoint) return null;
  const profiles = readProfiles();
  const existing = profiles.find((profile) => profile.endpoint === endpoint) || null;
  if (existing) return existing;
  if (profiles.some(isReadyProfileCandidate)) return null;
  return saveControlPlaneProfile({
    name: CURRENT_CONTROL_PLANE_PROFILE_NAME,
    endpoint,
    state: 'discovered',
    authState: 'unpaired',
    lastError: ''
  });
}

export function isControlPlaneProfileReady(profile: Pick<ControlPlaneProfile, 'authState' | 'state' | 'deviceToken'> | null) {
  return Boolean(
    profile
      && profile.authState === 'paired'
      && profile.state !== 'degraded'
      && profile.state !== 'revoked'
      && normalizeText(profile.deviceToken, 4096)
  );
}

export function isControlPlaneProfileRefreshable(profile: Pick<ControlPlaneProfile, 'authState' | 'state' | 'deviceToken'> | null) {
  return Boolean(
    profile
      && profile.authState === 'paired'
      && profile.state !== 'revoked'
      && normalizeText(profile.deviceToken, 4096)
  );
}

export interface ControlPlaneProfileNodeSummary {
  total: number;
  cached: number;
  online: number;
  offline: number;
  unknown: number;
  disabled: number;
  dataPlaneTransports: number;
  bootstrapTransports: number;
  underlayTransports: number;
  lastSeenAt: number;
  transportKinds: string[];
}

function maxTimestamp(...values: unknown[]): number {
  return values.reduce<number>((max, value) => {
    const timestamp = Math.max(0, Number(value) || 0);
    return timestamp > max ? timestamp : max;
  }, 0);
}

function addTransportKind(kinds: Set<string>, value: unknown) {
  const kind = normalizeText(value, 64);
  if (kind) kinds.add(kind);
}

export function summarizeControlPlaneProfileNodes(
  profile: Pick<ControlPlaneProfile, 'nodes' | 'nodeCount'> | null
): ControlPlaneProfileNodeSummary {
  const nodes = Array.isArray(profile?.nodes) ? profile.nodes : [];
  const transportKinds = new Set<string>();
  const summary = nodes.reduce<ControlPlaneProfileNodeSummary>((next, node) => {
    const status = node.connection?.status || 'unknown';
    if (status === 'online') next.online += 1;
    else if (status === 'offline') next.offline += 1;
    else next.unknown += 1;
    if (node.disabled) next.disabled += 1;
    addTransportKind(transportKinds, node.connection?.transportKind);
    (node.preferredTransports || []).forEach((kind) => addTransportKind(transportKinds, kind));
    (node.transports || []).forEach((transport) => {
      addTransportKind(transportKinds, transport.kind);
      if (transport.routeRole === 'bootstrap') next.bootstrapTransports += 1;
      else if (transport.routeRole === 'underlay') next.underlayTransports += 1;
      else next.dataPlaneTransports += 1;
      next.lastSeenAt = maxTimestamp(next.lastSeenAt, transport.updatedAt, transport.createdAt);
    });
    next.lastSeenAt = maxTimestamp(next.lastSeenAt, node.lastSeenAt, node.connection?.lastSeenAt);
    return next;
  }, {
    total: 0,
    cached: nodes.length,
    online: 0,
    offline: 0,
    unknown: 0,
    disabled: 0,
    dataPlaneTransports: 0,
    bootstrapTransports: 0,
    underlayTransports: 0,
    lastSeenAt: 0,
    transportKinds: []
  });
  summary.total = Math.max(nodes.length, Math.max(0, Number(profile?.nodeCount) || 0));
  summary.unknown += Math.max(0, summary.total - nodes.length);
  summary.transportKinds = Array.from(transportKinds).sort();
  return summary;
}

export function summarizeControlPlaneProfiles(profiles: ControlPlaneProfile[] = []) {
  return (Array.isArray(profiles) ? profiles : []).reduce((summary, profile) => {
    summary.total += 1;
    if (profile.authState === 'paired') summary.paired += 1;
    if (isControlPlaneProfileReady(profile)) summary.ready += 1;
    if (profile.state === 'degraded') summary.degraded += 1;
    if (profile.state === 'revoked') summary.revoked += 1;
    summary.nodes += Math.max(0, Number(profile.nodeCount) || 0);
    summary.accounts += Math.max(0, Number(profile.accountCount) || 0);
    summary.activeAccounts += Math.max(0, Number(profile.activeAccountCount) || 0);
    summary.schedulableAccounts += Math.max(0, Number(profile.schedulableAccountCount) || 0);
    summary.sessions += Math.max(0, Number(profile.sessionCount) || 0);
    return summary;
  }, {
    total: 0,
    paired: 0,
    ready: 0,
    degraded: 0,
    revoked: 0,
    nodes: 0,
    accounts: 0,
    activeAccounts: 0,
    schedulableAccounts: 0,
    sessions: 0
  });
}

export type ControlPlaneClientReadinessStatus = 'ready' | 'attention' | 'blocked';

export interface ControlPlaneClientReadinessItem {
  id: 'profile-store' | 'server-switching' | 'active-server' | 'device-token' | 'node-data-plane';
  label: string;
  status: ControlPlaneClientReadinessStatus;
  detail: string;
}

function createClientReadinessItem(
  id: ControlPlaneClientReadinessItem['id'],
  label: string,
  status: ControlPlaneClientReadinessStatus,
  detail: string
): ControlPlaneClientReadinessItem {
  return { id, label, status, detail };
}

export function summarizeControlPlaneClientReadiness(
  profiles: ControlPlaneProfile[] = [],
  activeProfileId = ''
): ControlPlaneClientReadinessItem[] {
  const items = Array.isArray(profiles) ? profiles : [];
  const activeId = normalizeText(activeProfileId, 96);
  const active = items.find((profile) => profile.id === activeId) || null;
  const readyCount = items.filter((profile) => isControlPlaneProfileReady(profile)).length;
  const pairedCount = items.filter((profile) => profile.authState === 'paired').length;
  const nodeSummary = summarizeControlPlaneProfileNodes(active);

  return [
    createClientReadinessItem(
      'profile-store',
      '本地服务器簿',
      items.length > 0 ? 'ready' : 'blocked',
      items.length > 0
        ? `已保存 ${items.length} 个 Control Plane，${pairedCount} 个已配对`
        : '还没有保存可切换的 Control Plane'
    ),
    createClientReadinessItem(
      'server-switching',
      '多服务器切换',
      items.length > 1 ? 'ready' : items.length === 1 ? 'attention' : 'blocked',
      items.length > 1
        ? `${items.length} 个 server 可在当前 client 内切换`
        : items.length === 1
          ? '当前只有 1 个 server；添加第二个后可直接切换'
          : '需要先配对或添加 Control Plane'
    ),
    createClientReadinessItem(
      'active-server',
      '当前服务器',
      !active || active.state === 'revoked'
        ? 'blocked'
        : active.state === 'degraded' || active.authState !== 'paired'
          ? 'attention'
          : 'ready',
      !active
        ? '未选择当前服务器'
        : active.state === 'revoked'
          ? `${active.name || active.endpoint} 已撤销`
          : active.state === 'degraded'
            ? `${active.name || active.endpoint} 同步异常`
            : active.authState !== 'paired'
              ? `${active.name || active.endpoint} 已探测但未配对`
              : `${active.name || active.endpoint} 已选中`
    ),
    createClientReadinessItem(
      'device-token',
      '设备身份',
      active && normalizeText(active.deviceToken, 4096) ? 'ready' : active ? 'attention' : 'blocked',
      active && normalizeText(active.deviceToken, 4096)
        ? 'device token 已保存，可读取账号、节点和会话摘要'
        : active
          ? '缺少 device token，只能作为未配对 server profile'
          : '需要配对后保存 device token'
    ),
    createClientReadinessItem(
      'node-data-plane',
      '节点数据面',
      !active ? 'blocked' : nodeSummary.online > 0 ? 'ready' : 'attention',
      !active
        ? '未选择 server，无法读取节点'
        : nodeSummary.total > 0
          ? `${nodeSummary.online}/${nodeSummary.total} 节点在线，${nodeSummary.dataPlaneTransports} 条数据面`
          : readyCount > 0
            ? '当前 server 尚未同步节点摘要'
            : '配对后同步节点摘要'
    )
  ];
}

export function saveControlPlaneProfile(input: {
  name?: string;
  endpoint: string;
  connectionMode?: ControlPlaneProfileConnectionMode;
  broker?: ControlPlaneProfileBroker | null;
  descriptor?: ControlPlaneDescriptor | null;
  state?: ControlPlaneProfileState;
  authState?: ControlPlaneProfile['authState'];
  deviceToken?: string;
  nodes?: ControlPlaneNodeSummary[];
  nodeCount?: number;
  accountCount?: number;
  activeAccountCount?: number;
  schedulableAccountCount?: number;
  sessionCount?: number;
  lastDeviceSyncAt?: number;
  lastStatusSyncAt?: number;
  lastAccountsSyncAt?: number;
  lastSessionsSyncAt?: number;
  lastError?: string;
}): ControlPlaneProfile {
  const endpointResolution = resolveControlPlaneProfileEndpointInput(input);
  const endpoint = endpointResolution.endpoint;
  const now = Date.now();
  const profiles = readProfiles();
  const existing = profiles.find((profile) => profile.endpoint === endpoint) || null;
  const descriptor = normalizeAnyDescriptor(input.descriptor) || existing?.descriptor || null;
  const lastError = normalizeText(input.lastError || '', 512);
  const nodes = input.nodes === undefined ? (existing?.nodes || []) : normalizeProfileNodes(input.nodes);
  const connectionMode = normalizeProfileConnectionMode(input.connectionMode || endpointResolution.connectionMode || existing?.connectionMode, endpoint);
  const broker = connectionMode === 'broker-proxy'
    ? normalizeProfileBroker(input.broker || endpointResolution.broker || existing?.broker, endpoint)
    : null;
  const state = inferProfileState({
    requestedState: input.state,
    requestedAuthState: input.authState,
    existing,
    descriptor,
    lastError
  });
  const profile: ControlPlaneProfile = {
    id: existing?.id || stableProfileId(endpoint),
    name: normalizeText(input.name, 120) || existing?.name || descriptor?.endpoint || endpoint,
    endpoint,
    connectionMode,
    broker,
    state,
    authState: inferAuthState(state, input.authState, existing),
    deviceToken: normalizeText(input.deviceToken || existing?.deviceToken || '', 4096),
    nodes,
    nodeCount: Math.max(nodes.length, Number(input.nodeCount === undefined ? existing?.nodeCount : input.nodeCount) || 0),
    accountCount: Math.max(0, Number(input.accountCount === undefined ? existing?.accountCount : input.accountCount) || 0),
    activeAccountCount: Math.max(0, Number(input.activeAccountCount === undefined ? existing?.activeAccountCount : input.activeAccountCount) || 0),
    schedulableAccountCount: Math.max(0, Number(input.schedulableAccountCount === undefined ? existing?.schedulableAccountCount : input.schedulableAccountCount) || 0),
    sessionCount: Math.max(0, Number(input.sessionCount === undefined ? existing?.sessionCount : input.sessionCount) || 0),
    lastDeviceSyncAt: Math.max(0, Number(input.lastDeviceSyncAt === undefined ? existing?.lastDeviceSyncAt : input.lastDeviceSyncAt) || 0),
    lastStatusSyncAt: Math.max(0, Number(input.lastStatusSyncAt === undefined ? existing?.lastStatusSyncAt : input.lastStatusSyncAt) || 0),
    lastAccountsSyncAt: Math.max(0, Number(input.lastAccountsSyncAt === undefined ? existing?.lastAccountsSyncAt : input.lastAccountsSyncAt) || 0),
    lastSessionsSyncAt: Math.max(0, Number(input.lastSessionsSyncAt === undefined ? existing?.lastSessionsSyncAt : input.lastSessionsSyncAt) || 0),
    descriptor,
    lastCheckedAt: descriptor ? now : (existing?.lastCheckedAt || 0),
    lastError,
    createdAt: existing?.createdAt || now,
    updatedAt: now
  };
  const next = profiles.filter((item) => item.id !== profile.id && item.endpoint !== profile.endpoint);
  next.unshift(profile);
  writeProfiles(next);
  persistSharedControlPlaneProfile(profile);
  return profile;
}

function createProfileApiClient(profile: Pick<ControlPlaneProfile, 'endpoint' | 'deviceToken'>, options: {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
} = {}) {
  return createControlPlaneApiClient({
    endpoint: profile.endpoint,
    token: profile.deviceToken,
    timeoutMs: options.timeoutMs || DEFAULT_DEVICE_REQUEST_TIMEOUT_MS,
    fetchImpl: options.fetchImpl
  });
}

async function fetchDeviceJson(profile: Pick<ControlPlaneProfile, 'endpoint' | 'deviceToken'>, path: string, options: {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
} = {}) {
  return createProfileApiClient(profile, options).getJson(path, {
    requireToken: true,
    httpErrorPrefix: 'control_plane_device_http'
  });
}

async function postDeviceJson(profile: Pick<ControlPlaneProfile, 'endpoint' | 'deviceToken'>, path: string, body: unknown, options: {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
} = {}) {
  return createProfileApiClient(profile, options).postJson(path, body, {
    requireToken: true,
    httpErrorPrefix: 'control_plane_device_http'
  });
}

function readPairLinkParam(params: URLSearchParams) {
  return normalizeText(
    params.get('pair')
      || params.get('pair_url')
      || params.get('pairUrl')
      || params.get('url'),
    4096
  );
}

function readPairUrlOrCodeParam(params: URLSearchParams) {
  return readPairLinkParam(params) || normalizeText(params.get('code'), 4096);
}

function readPairEndpointParam(params: URLSearchParams) {
  return normalizeControlPlaneEndpoint(
    params.get('endpoint')
      || params.get('controlEndpoint')
      || params.get('control_endpoint')
      || ''
  );
}

export function parseControlPlanePairInput(pairUrlOrCode: string, fallbackEndpoint = '') {
  const raw = normalizeText(pairUrlOrCode, 4096);
  const fallback = normalizeControlPlaneEndpoint(fallbackEndpoint);
  if (!raw) {
    return {
      endpoint: fallback,
      code: ''
    };
  }
  try {
    const parsed = new URL(raw);
    const explicitEndpoint = readPairEndpointParam(parsed.searchParams);
    const nestedPairUrlOrCode = readPairLinkParam(parsed.searchParams);
    if (nestedPairUrlOrCode && nestedPairUrlOrCode !== raw) {
      return parseControlPlanePairInput(nestedPairUrlOrCode, explicitEndpoint || fallback);
    }
    const code = normalizeText(parsed.searchParams.get('code'), 4096);
    const markers = ['/v0/fabric/device-pair', '/v0/node-rpc/device-pair'];
    const markerIndex = markers
      .map((marker) => parsed.pathname.indexOf(marker))
      .filter((index) => index >= 0)
      .sort((left, right) => left - right)[0] ?? -1;
    const basePath = markerIndex > 0 ? parsed.pathname.slice(0, markerIndex) : '';
    const endpoint = explicitEndpoint || normalizeControlPlaneEndpoint(`${parsed.protocol}//${parsed.host}${basePath}`);
    return {
      endpoint,
      code
    };
  } catch (_error) {
    return {
      endpoint: fallback,
      code: raw
    };
  }
}

export function parseControlPlanePairIntentFromSearch(search: string) {
  const raw = normalizeText(search, 8192);
  const params = new URLSearchParams(raw.startsWith('?') ? raw.slice(1) : raw);
  const pairUrlOrCode = readPairUrlOrCodeParam(params);
  const endpoint = readPairEndpointParam(params);
  const parsed = parseControlPlanePairInput(pairUrlOrCode, endpoint);
  return {
    pairUrlOrCode,
    endpoint: parsed.endpoint || endpoint,
    code: parsed.code,
    autoSubmit: Boolean(pairUrlOrCode && (parsed.endpoint || endpoint) && parsed.code)
  };
}

export async function pairControlPlaneDevice(input: {
  pairUrlOrCode?: string;
  endpoint?: string;
  connectionMode?: ControlPlaneProfileConnectionMode;
  broker?: ControlPlaneProfileBroker | null;
  code?: string;
  deviceId?: string;
  deviceName?: string;
  platform?: string;
}, options: {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
} = {}) {
  const parsed = parseControlPlanePairInput(input.pairUrlOrCode || input.code || '', input.endpoint || '');
  const endpointResolution = shouldForcePairEndpoint(input)
    ? resolveControlPlaneProfileEndpointInput(input)
    : null;
  const endpoint = endpointResolution?.endpoint || normalizeControlPlaneEndpoint(parsed.endpoint || input.endpoint || '');
  const code = normalizeText(input.code || parsed.code, 4096);
  if (!endpoint) {
    throw new Error('invalid_control_plane_endpoint');
  }
  if (!code) {
    throw new Error('missing_control_plane_pair_code');
  }
  const client = createControlPlaneApiClient({
    endpoint,
    timeoutMs: options.timeoutMs || DEFAULT_PAIR_REQUEST_TIMEOUT_MS,
    fetchImpl: options.fetchImpl
  });
  const pairResult = normalizeDevicePairResponse(await client.postJson('/v0/fabric/device-pair', {
    code,
    device: {
      id: normalizeText(input.deviceId, 96),
      name: normalizeText(input.deviceName, 120),
      platform: normalizeText(input.platform, 64)
    }
  }, { httpErrorPrefix: 'fabric_device_pair_http' }));
  if (!pairResult) {
    throw new Error('invalid_control_plane_device_pair_response');
  }
  const descriptor = await fetchControlPlaneDescriptor(endpoint, options);
  const profile = saveControlPlaneProfile({
    name: descriptor.endpoint || endpoint,
    endpoint,
    connectionMode: endpointResolution?.connectionMode,
    broker: endpointResolution?.broker,
    descriptor,
    state: pairResult.device.state === 'revoked' ? 'revoked' : 'paired',
    authState: pairResult.device.state === 'revoked' ? 'unpaired' : 'paired',
    deviceToken: pairResult.token,
    lastError: ''
  });
  return {
    profile,
    device: pairResult.device,
    token: pairResult.token,
    descriptor
  };
}

export async function fetchControlPlaneDeviceProfile(profile: Pick<ControlPlaneProfile, 'endpoint' | 'deviceToken'>, options: {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
} = {}) {
  const payload = await fetchDeviceJson(profile, '/v0/node-rpc/device-profile', options);
  const result = normalizeDeviceProfile(payload);
  if (!result) {
    throw new Error('invalid_control_plane_device_profile');
  }
  return result;
}

export async function fetchControlPlaneDeviceNodes(profile: Pick<ControlPlaneProfile, 'endpoint' | 'deviceToken'>, options: {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
} = {}): Promise<ControlPlaneNodeSummary[]> {
  const payload = await fetchDeviceJson(profile, '/v0/node-rpc/device-nodes', options);
  return normalizeDeviceNodes(payload);
}

export async function fetchControlPlaneDeviceStatus(profile: Pick<ControlPlaneProfile, 'endpoint' | 'deviceToken'>, options: {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
} = {}): Promise<ControlPlaneDeviceStatus> {
  const payload = await fetchDeviceJson(profile, '/v0/node-rpc/device-status', options);
  const status = normalizeDeviceStatus(payload);
  if (!status) {
    throw new Error('invalid_control_plane_device_status');
  }
  return status;
}

export async function fetchControlPlaneDeviceAccounts(profile: Pick<ControlPlaneProfile, 'endpoint' | 'deviceToken'>, options: {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
} = {}) {
  const payload = await fetchDeviceJson(profile, '/v0/node-rpc/device-accounts', options);
  return normalizeDeviceAccounts(payload);
}

export async function fetchControlPlaneDeviceSessions(profile: Pick<ControlPlaneProfile, 'endpoint' | 'deviceToken'>, options: {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
} = {}) {
  const payload = await fetchDeviceJson(profile, '/v0/node-rpc/device-sessions', options);
  return normalizeDeviceSessions(payload);
}

export async function fetchControlPlaneDeviceNodeSessions(
  profile: Pick<ControlPlaneProfile, 'endpoint' | 'deviceToken'>,
  nodeId: string,
  options: {
    limit?: number;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
  } = {}
) {
  const node = normalizeText(nodeId, 96);
  const params = new URLSearchParams({ nodeId: node });
  if (options.limit !== undefined) params.set('limit', String(options.limit));
  const payload = await fetchDeviceJson(profile, `/v0/node-rpc/device-node-sessions?${params.toString()}`, options);
  return normalizeDeviceNodeSessions(payload);
}

export async function fetchControlPlaneDeviceSessionMessages(
  profile: Pick<ControlPlaneProfile, 'endpoint' | 'deviceToken'>,
  sessionRef: string,
  options: {
    limit?: number;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
  } = {}
) {
  const ref = normalizeText(sessionRef, 96);
  const params = new URLSearchParams({ sessionRef: ref });
  if (options.limit !== undefined) params.set('limit', String(options.limit));
  const payload = await fetchDeviceJson(profile, `/v0/node-rpc/device-session-messages?${params.toString()}`, options);
  return normalizeDeviceSessionMessages(payload);
}

export async function fetchControlPlaneDeviceNodeSessionMessages(
  profile: Pick<ControlPlaneProfile, 'endpoint' | 'deviceToken'>,
  nodeId: string,
  sessionRef: string,
  options: {
    limit?: number;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
  } = {}
) {
  const node = normalizeText(nodeId, 96);
  const ref = normalizeText(sessionRef, 96);
  const params = new URLSearchParams({ nodeId: node, sessionRef: ref });
  if (options.limit !== undefined) params.set('limit', String(options.limit));
  const payload = await fetchDeviceJson(profile, `/v0/node-rpc/device-node-session-messages?${params.toString()}`, options);
  return normalizeDeviceNodeSessionMessages(payload);
}

export async function sendControlPlaneDeviceNodeSessionInput(
  profile: Pick<ControlPlaneProfile, 'endpoint' | 'deviceToken'>,
  nodeId: string,
  sessionRef: string,
  input: string,
  options: {
    appendNewline?: boolean;
    promptId?: string;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
  } = {}
) {
  const payload = await postDeviceJson(profile, '/v0/node-rpc/device-node-session-input', {
    nodeId: normalizeText(nodeId, 96),
    sessionRef: normalizeText(sessionRef, 96),
    input: String(input ?? ''),
    appendNewline: options.appendNewline !== false,
    promptId: normalizeText(options.promptId, 256)
  }, options);
  return normalizeDeviceNodeSessionInput(payload);
}

export async function fetchControlPlaneDeviceSessionEvents(
  profile: Pick<ControlPlaneProfile, 'endpoint' | 'deviceToken'>,
  sessionRef: string,
  options: {
    cursor?: number;
    limit?: number;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
  } = {}
) {
  const ref = normalizeText(sessionRef, 96);
  const params = new URLSearchParams({ sessionRef: ref });
  if (options.cursor !== undefined) params.set('cursor', String(options.cursor));
  if (options.limit !== undefined) params.set('limit', String(options.limit));
  const payload = await fetchDeviceJson(profile, `/v0/node-rpc/device-session-events?${params.toString()}`, options);
  return normalizeDeviceSessionEvents(payload);
}

export function buildControlPlaneDeviceSessionStreamRequest(
  profile: Pick<ControlPlaneProfile, 'endpoint' | 'deviceToken'>,
  sessionRef: string,
  options: {
    cursor?: number;
    limit?: number;
    intervalMs?: number;
    timeoutMs?: number;
  } = {}
): ControlPlaneEventStreamRequest {
  const ref = normalizeText(sessionRef, 96);
  const params = new URLSearchParams({ sessionRef: ref });
  if (options.cursor !== undefined) params.set('cursor', String(options.cursor));
  if (options.limit !== undefined) params.set('limit', String(options.limit));
  if (options.intervalMs !== undefined) params.set('intervalMs', String(options.intervalMs));
  return createProfileApiClient(profile, options)
    .buildEventStreamRequest(`/v0/node-rpc/device-session-stream?${params.toString()}`, {
      requireToken: true
    });
}

export function streamControlPlaneDeviceSessionEvents(
  profile: Pick<ControlPlaneProfile, 'endpoint' | 'deviceToken'>,
  sessionRef: string,
  handlers: {
    onFrame: (frame: ReturnType<typeof normalizeDeviceSessionEvents>) => void;
  },
  options: {
    cursor?: number;
    limit?: number;
    intervalMs?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
    fetchImpl?: ControlPlaneEventStreamFetch;
  } = {}
) {
  const request = buildControlPlaneDeviceSessionStreamRequest(profile, sessionRef, options);
  return consumeControlPlaneEventStream(request, {
    onFrame: (frame) => {
      const normalized = normalizeDeviceSessionStreamFrame(frame);
      if (!normalized) {
        throw new Error('invalid_control_plane_device_session_stream_frame');
      }
      handlers.onFrame(normalized);
    }
  }, {
    fetchImpl: options.fetchImpl,
    signal: options.signal,
    httpErrorPrefix: 'control_plane_device_session_stream_http'
  });
}

export function buildControlPlaneDeviceNodeSessionStreamRequest(
  profile: Pick<ControlPlaneProfile, 'endpoint' | 'deviceToken'>,
  nodeId: string,
  sessionRef: string,
  options: {
    cursor?: number;
    limit?: number;
    intervalMs?: number;
    timeoutMs?: number;
  } = {}
): ControlPlaneEventStreamRequest {
  const node = normalizeText(nodeId, 96);
  const ref = normalizeText(sessionRef, 96);
  const params = new URLSearchParams({ nodeId: node, sessionRef: ref });
  if (options.cursor !== undefined) params.set('cursor', String(options.cursor));
  if (options.limit !== undefined) params.set('limit', String(options.limit));
  if (options.intervalMs !== undefined) params.set('intervalMs', String(options.intervalMs));
  return createProfileApiClient(profile, options)
    .buildEventStreamRequest(`/v0/node-rpc/device-node-session-stream?${params.toString()}`, {
      requireToken: true
    });
}

export function streamControlPlaneDeviceNodeSessionEvents(
  profile: Pick<ControlPlaneProfile, 'endpoint' | 'deviceToken'>,
  nodeId: string,
  sessionRef: string,
  handlers: {
    onFrame: (frame: NonNullable<ReturnType<typeof normalizeDeviceNodeSessionStreamFrame>>) => void;
  },
  options: {
    cursor?: number;
    limit?: number;
    intervalMs?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
    fetchImpl?: ControlPlaneEventStreamFetch;
  } = {}
) {
  const request = buildControlPlaneDeviceNodeSessionStreamRequest(profile, nodeId, sessionRef, options);
  return consumeControlPlaneEventStream(request, {
    onFrame: (frame) => {
      const normalized = normalizeDeviceNodeSessionStreamFrame(frame);
      if (!normalized) {
        throw new Error('invalid_control_plane_device_node_session_stream_frame');
      }
      handlers.onFrame(normalized);
    }
  }, {
    fetchImpl: options.fetchImpl,
    signal: options.signal,
    httpErrorPrefix: 'control_plane_device_node_session_stream_http'
  });
}

export async function refreshControlPlaneDeviceState(profile: ControlPlaneProfile, options: {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
} = {}) {
  const [deviceProfile, nodes, status, accounts, sessions] = await Promise.all([
    fetchControlPlaneDeviceProfile(profile, options),
    fetchControlPlaneDeviceNodes(profile, options),
    fetchControlPlaneDeviceStatus(profile, options),
    fetchControlPlaneDeviceAccounts(profile, options),
    fetchControlPlaneDeviceSessions(profile, options)
  ]);
  const schedulableCount = Number(accounts.summary.bySchedulableStatus.schedulable) || 0;
  const now = Date.now();
  const nextProfile = saveControlPlaneProfile({
    name: profile.name,
    endpoint: profile.endpoint,
    descriptor: deviceProfile.descriptor,
    state: deviceProfile.device.state === 'revoked' ? 'revoked' : 'paired',
    authState: deviceProfile.device.state === 'revoked' ? 'unpaired' : 'paired',
    deviceToken: profile.deviceToken,
    nodes,
    nodeCount: nodes.length,
    accountCount: status.totalAccounts,
    activeAccountCount: status.activeAccounts,
    schedulableAccountCount: schedulableCount,
    sessionCount: sessions.summary.total,
    lastDeviceSyncAt: now,
    lastStatusSyncAt: now,
    lastAccountsSyncAt: now,
    lastSessionsSyncAt: now,
    lastError: ''
  });
  return {
    profile: nextProfile,
    device: deviceProfile.device,
    nodes,
    status,
    accounts: accounts.accounts,
    accountSummary: accounts.summary,
    sessions: sessions.sessions,
    sessionSummary: sessions.summary
  };
}

function normalizeRefreshError(error: unknown) {
  if (error instanceof Error && error.message) return normalizeText(error.message, 512);
  return normalizeText(error, 512) || 'control_plane_refresh_failed';
}

export async function refreshControlPlaneProfileStates(profiles: ControlPlaneProfile[] = [], options: {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
} = {}) {
  const entries = Array.isArray(profiles) ? profiles : [];
  const results = await Promise.all(entries.map(async (profile) => {
    if (!isControlPlaneProfileRefreshable(profile)) {
      return {
        profileId: profile.id,
        endpoint: profile.endpoint,
        status: 'skipped' as const,
        profile
      };
    }

    try {
      const refreshed = await refreshControlPlaneDeviceState(profile, options);
      return {
        profileId: profile.id,
        endpoint: profile.endpoint,
        status: 'refreshed' as const,
        profile: refreshed.profile
      };
    } catch (error) {
      const failedProfile = saveControlPlaneProfile({
        name: profile.name,
        endpoint: profile.endpoint,
        descriptor: profile.descriptor,
        state: 'degraded',
        authState: profile.authState,
        deviceToken: profile.deviceToken,
        lastError: normalizeRefreshError(error)
      });
      return {
        profileId: profile.id,
        endpoint: profile.endpoint,
        status: 'failed' as const,
        profile: failedProfile,
        error: failedProfile.lastError
      };
    }
  }));

  return {
    profiles: listControlPlaneProfiles(),
    results,
    refreshed: results.filter((item) => item.status === 'refreshed').length,
    failed: results.filter((item) => item.status === 'failed').length,
    skipped: results.filter((item) => item.status === 'skipped').length
  };
}

export function removeControlPlaneProfile(profileId: string): ControlPlaneProfile[] {
  const id = normalizeText(profileId, 96);
  const next = readProfiles().filter((profile) => profile.id !== id);
  writeProfiles(next);
  removeSharedControlPlaneProfile(id);
  return next;
}

export async function fetchControlPlaneDescriptor(endpoint: string, options: {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
} = {}): Promise<ControlPlaneDescriptor> {
  const client = createControlPlaneApiClient({
    endpoint,
    timeoutMs: options.timeoutMs || DEFAULT_DESCRIPTOR_TIMEOUT_MS,
    fetchImpl: options.fetchImpl
  });
  const payload = await client.getJson('/v0/fabric/descriptor', {
    httpErrorPrefix: 'fabric_descriptor_http'
  }) as ControlPlaneDescriptorResponse | ControlPlaneDescriptor;
  const descriptor = normalizeAnyDescriptor('result' in payload ? payload.result : payload);
  if (!descriptor) {
    throw new Error('invalid_fabric_descriptor');
  }
  return {
    ...descriptor,
    endpoint: descriptor.endpoint || normalizeControlPlaneEndpoint(endpoint)
  };
}
