import { resolveWebUiManagementKey } from './webui-auth-transport';
import type {
  ControlPlaneDescriptor,
  ControlPlaneDescriptorResponse,
  ControlPlaneDeviceStatus,
  ControlPlaneNodeSummary,
  ControlPlaneProfileBroker,
  ControlPlaneProfileConnectionMode,
  ControlPlaneProfileState,
  ControlPlaneProfile,
  ServerAuthorizationState,
  ServerRoute
} from '@/types';
import type {
  ControlPlaneEventStreamFetch,
  ControlPlaneEventStreamRequest
} from './control-plane-api-client';
import {
  consumeControlPlaneEventStream,
  createControlPlaneApiClient,
  normalizeControlPlaneEndpoint
} from './control-plane-api-client';
import {
  isNativeDesktopRuntime,
  listNativeServerProfiles,
  removeNativeServerProfile,
  setActiveNativeServerProfile,
  upsertNativeServerProfile,
  type NativeServerProfileSummary
} from './native-server-profile-repository';
import {
  isNativeServerTransportAvailable,
  openNativeServerSse,
  requestNativeServerJson
} from './native-server-transport';
import {
  mergeServerRoutes,
  migrateLegacyServerRoutes,
  normalizeStableServerId
} from './server-routes/server-route-service';

export { normalizeControlPlaneEndpoint };

import {
  getCurrentWebUiControlPlaneEndpoint,
  hasConfiguredManagementKey,
  inferProfileState,
  normalizeAnyDescriptor,
  normalizeDeviceAccounts,
  normalizeDeviceNodeSessionInput,
  normalizeDeviceNodeSessionMessages,
  normalizeDeviceNodeSessionStreamFrame,
  normalizeDeviceNodeSessions,
  normalizeDeviceNodes,
  normalizeDeviceSessionEvents,
  normalizeDeviceSessionMessages,
  normalizeDeviceSessionStreamFrame,
  normalizeDeviceSessions,
  normalizeDeviceStatus,
  normalizeProfile,
  normalizeProfileBroker,
  normalizeProfileConnectionMode,
  normalizeProfileNodes,
  normalizeText,
  resolveControlPlaneProfileEndpointInput,
  resolveServerAuthorizationState,
  selectProfileRoute,
  stableProfileId,
} from './control-plane-profile-normalization';

export {
  CONTROL_PLANE_PROFILE_STATES,
  CONTROL_PLANE_PROFILE_CONNECTION_MODES,
  buildFabricBrokerProxyEndpoint,
  resolveControlPlaneProfileEndpointInput,
  normalizeControlPlaneProfileState,
  buildControlPlaneDescriptorUrl,
} from './control-plane-profile-normalization';

export type {
  ControlPlaneProfileEndpointInput,
  ControlPlaneProfileEndpointResolution,
} from './control-plane-profile-normalization';


const STORAGE_KEY = 'aih:control-plane-profiles:v1';
export const CONTROL_PLANE_PROFILES_CHANGED_EVENT = 'aih:control-plane-profiles-changed';
const SHARED_PROFILE_API_PATH = '/v0/webui/control-plane/profiles';

// 共享 profile 同步是裸 fetch，必须显式携带当前 Server 的 Management Key。
function sharedProfileAuthHeaders(): Record<string, string> {
  const managementKey = resolveWebUiManagementKey();
  return managementKey ? { authorization: `Bearer ${managementKey}` } : {};
}
const DEFAULT_DESCRIPTOR_TIMEOUT_MS = 8000;
const DEFAULT_DEVICE_REQUEST_TIMEOUT_MS = 10000;
const CURRENT_CONTROL_PLANE_PROFILE_NAME = '当前 Server';

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
  if (typeof window === 'undefined' || isNativeDesktopRuntime()) return null;
  const fetcher = (window as Window & { fetch?: typeof fetch }).fetch;
  return typeof fetcher === 'function' ? fetcher.bind(window) : null;
}


function mergeLogicalServerProfiles(
  left: ControlPlaneProfile | null,
  right: ControlPlaneProfile | null
): ControlPlaneProfile | null {
  if (!left) return right;
  if (!right) return left;
  const preferred = chooseProfileForMerge(left, right) || right;
  const secondary = preferred === left ? right : left;
  const routes = mergeServerRoutes(left.routes, right.routes);
  const activeRoute = selectProfileRoute(
    routes,
    preferred.activeRouteId,
    preferred.endpoint
  );
  const managementKey = preferred.managementKey || secondary.managementKey;
  const managementKeyConfigured = Boolean(
    preferred.managementKeyConfigured
      || secondary.managementKeyConfigured
      || managementKey
  );
  return {
    ...secondary,
    ...preferred,
    stableServerId: preferred.stableServerId || secondary.stableServerId,
    endpoint: activeRoute?.endpoint || preferred.endpoint,
    routes,
    activeRouteId: activeRoute?.id || '',
    managementKey,
    credentialRef: preferred.credentialRef || secondary.credentialRef,
    managementKeyConfigured,
    authorizationState: resolveServerAuthorizationState(managementKeyConfigured)
  };
}

function readProfiles(storage = getStorage()): ControlPlaneProfile[] {
  if (!storage) return [];
  try {
    const parsed = JSON.parse(storage.getItem(STORAGE_KEY) || '[]');
    const source = Array.isArray(parsed) ? parsed : [];
    const normalizedProfiles = source
      .map(normalizeProfile)
      .filter((item): item is ControlPlaneProfile => Boolean(item));
    const byStableServerId = new Map<string, ControlPlaneProfile>();
    normalizedProfiles.forEach((profile) => {
      const merged = mergeLogicalServerProfiles(
        byStableServerId.get(profile.stableServerId) || null,
        profile
      );
      if (merged) byStableServerId.set(profile.stableServerId, merged);
    });
    const profiles = Array.from(byStableServerId.values())
      .sort((left, right) => right.updatedAt - left.updatedAt || left.name.localeCompare(right.name));
    const normalized = JSON.stringify(profiles);
    if (normalized !== JSON.stringify(source)) {
      if (profiles.length > 0) storage.setItem(STORAGE_KEY, normalized);
      else storage.removeItem(STORAGE_KEY);
    }
    return profiles;
  } catch (_error) {
    return [];
  }
}

function isReadyProfileCandidate(profile: ControlPlaneProfile | null | undefined) {
  return Boolean(
    profile
      && profile.state === 'ready'
      && hasConfiguredManagementKey(profile)
  );
}

export function isAutoCurrentControlPlaneProfile(profile: ControlPlaneProfile | null | undefined) {
  const currentEndpoint = getCurrentWebUiControlPlaneEndpoint();
  return Boolean(
    profile
      && currentEndpoint
      && profile.endpoint === currentEndpoint
      && profile.name === CURRENT_CONTROL_PLANE_PROFILE_NAME
      && !hasConfiguredManagementKey(profile)
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
  const byStableServerId = new Map<string, ControlPlaneProfile>();
  localProfiles.forEach((profile) => {
    const merged = mergeLogicalServerProfiles(
      byStableServerId.get(profile.stableServerId) || null,
      profile
    );
    if (merged) byStableServerId.set(profile.stableServerId, merged);
  });
  sharedProfiles.forEach((profile) => {
    const merged = mergeLogicalServerProfiles(
      byStableServerId.get(profile.stableServerId) || null,
      profile
    );
    if (merged) byStableServerId.set(profile.stableServerId, merged);
  });
  const merged = Array.from(byStableServerId.values());
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
    headers: { accept: 'application/json', ...sharedProfileAuthHeaders() },
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
      'content-type': 'application/json',
      ...sharedProfileAuthHeaders()
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
    headers: { accept: 'application/json', ...sharedProfileAuthHeaders() },
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
    state: 'offline',
    lastError: ''
  });
}

export function isControlPlaneProfileReady(profile: Pick<
  ControlPlaneProfile,
  'state' | 'managementKey' | 'managementKeyConfigured'
> | null) {
  return Boolean(
    profile
      && profile.state === 'ready'
      && hasConfiguredManagementKey(profile)
  );
}

export function isControlPlaneProfileRefreshable(profile: Pick<
  ControlPlaneProfile,
  'managementKey' | 'managementKeyConfigured'
> | null) {
  return hasConfiguredManagementKey(profile);
}

export function isControlPlaneManagementKeyConfigured(profile: Pick<
  ControlPlaneProfile,
  'managementKey' | 'managementKeyConfigured'
> | null) {
  return hasConfiguredManagementKey(profile);
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
    if (isControlPlaneProfileReady(profile)) summary.ready += 1;
    if (profile.state === 'degraded') summary.degraded += 1;
    if (profile.state === 'offline') summary.offline += 1;
    summary.nodes += Math.max(0, Number(profile.nodeCount) || 0);
    summary.accounts += Math.max(0, Number(profile.accountCount) || 0);
    summary.activeAccounts += Math.max(0, Number(profile.activeAccountCount) || 0);
    summary.schedulableAccounts += Math.max(0, Number(profile.schedulableAccountCount) || 0);
    summary.sessions += Math.max(0, Number(profile.sessionCount) || 0);
    return summary;
  }, {
    total: 0,
    ready: 0,
    degraded: 0,
    offline: 0,
    nodes: 0,
    accounts: 0,
    activeAccounts: 0,
    schedulableAccounts: 0,
    sessions: 0
  });
}

export type ControlPlaneClientReadinessStatus = 'ready' | 'attention' | 'blocked';

export interface ControlPlaneClientReadinessItem {
  id: 'profile-store' | 'server-switching' | 'active-server' | 'management-key' | 'node-data-plane';
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
  const configuredCount = items.filter(hasConfiguredManagementKey).length;
  const nodeSummary = summarizeControlPlaneProfileNodes(active);

  return [
    createClientReadinessItem(
      'profile-store',
      '本地服务器簿',
      items.length > 0 ? 'ready' : 'blocked',
      items.length > 0
        ? `已保存 ${items.length} 个 Server，${configuredCount} 个已配置 Key`
        : '还没有保存可切换的 Server'
    ),
    createClientReadinessItem(
      'server-switching',
      '多服务器切换',
      items.length > 1 ? 'ready' : items.length === 1 ? 'attention' : 'blocked',
      items.length > 1
        ? `${items.length} 个 server 可在当前 client 内切换`
        : items.length === 1
          ? '当前只有 1 个 server；添加第二个后可直接切换'
          : '需要先添加 Server 并配置 Management Key'
    ),
    createClientReadinessItem(
      'active-server',
      '当前服务器',
      !active ? 'blocked' : active.state === 'ready' ? 'ready' : 'attention',
      !active
        ? '未选择当前服务器'
        : active.state === 'degraded'
          ? `${active.name || active.endpoint} 同步异常`
          : active.state === 'offline'
            ? `${active.name || active.endpoint} 当前离线`
            : `${active.name || active.endpoint} 已选中`
    ),
    createClientReadinessItem(
      'management-key',
      'Management Key',
      active && hasConfiguredManagementKey(active) ? 'ready' : active ? 'attention' : 'blocked',
      active && hasConfiguredManagementKey(active)
        ? 'Management Key 已保存，可读取账号、节点和会话摘要'
        : active
          ? '缺少 Management Key'
          : '添加 Server 时需要保存 Management Key'
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
            : '配置 Management Key 后同步节点摘要'
    )
  ];
}

export interface ControlPlaneProfileSaveInput {
  name?: string;
  stableServerId?: string;
  endpoint?: string;
  routes?: Array<Partial<ServerRoute> & Pick<ServerRoute, 'kind' | 'endpoint'>>;
  activeRouteId?: string;
  authorizationState?: ServerAuthorizationState;
  connectionMode?: ControlPlaneProfileConnectionMode;
  broker?: ControlPlaneProfileBroker | null;
  descriptor?: ControlPlaneDescriptor | null;
  state?: ControlPlaneProfileState;
  managementKey?: string;
  credentialRef?: string;
  managementKeyConfigured?: boolean;
  nodes?: ControlPlaneNodeSummary[];
  nodeCount?: number;
  accountCount?: number;
  activeAccountCount?: number;
  schedulableAccountCount?: number;
  sessionCount?: number;
  lastNodeSyncAt?: number;
  lastStatusSyncAt?: number;
  lastAccountsSyncAt?: number;
  lastSessionsSyncAt?: number;
  lastError?: string;
}

function createNativeProfileMetadata(profile: ControlPlaneProfile): Record<string, unknown> {
  return {
    stableServerId: profile.stableServerId,
    routes: profile.routes,
    activeRouteId: profile.activeRouteId,
    authorizationState: profile.authorizationState,
    connectionMode: profile.connectionMode,
    broker: profile.broker,
    state: profile.state,
    nodeCount: profile.nodeCount,
    accountCount: profile.accountCount,
    activeAccountCount: profile.activeAccountCount,
    schedulableAccountCount: profile.schedulableAccountCount,
    sessionCount: profile.sessionCount,
    lastNodeSyncAt: profile.lastNodeSyncAt,
    lastStatusSyncAt: profile.lastStatusSyncAt,
    lastAccountsSyncAt: profile.lastAccountsSyncAt,
    lastSessionsSyncAt: profile.lastSessionsSyncAt,
    descriptor: profile.descriptor,
    lastCheckedAt: profile.lastCheckedAt,
    lastError: profile.lastError
  };
}

function mapNativeServerProfile(summary: NativeServerProfileSummary): ControlPlaneProfile | null {
  return normalizeProfile({
    ...summary.metadata,
    id: summary.id,
    name: summary.name,
    endpoint: summary.endpoint,
    managementKey: '',
    credentialRef: summary.credentialRef,
    managementKeyConfigured: summary.managementKeyConfigured,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt
  });
}

export async function initializeNativeControlPlaneProfiles() {
  if (!isNativeDesktopRuntime()) {
    return {
      profiles: listControlPlaneProfiles(),
      activeProfileId: ''
    };
  }
  const native = await listNativeServerProfiles();
  const profiles = native.profiles
    .map(mapNativeServerProfile)
    .filter((profile): profile is ControlPlaneProfile => Boolean(profile));
  writeProfiles(profiles);
  const activeProfileId = native.activeProfileId
    || profiles.find(isReadyProfileCandidate)?.id
    || profiles[0]?.id
    || '';
  if (activeProfileId && activeProfileId !== native.activeProfileId) {
    await setActiveNativeServerProfile(activeProfileId);
  }
  return {
    profiles,
    activeProfileId
  };
}

export async function saveControlPlaneProfileSecure(
  input: ControlPlaneProfileSaveInput
): Promise<ControlPlaneProfile> {
  if (!isNativeDesktopRuntime()) return saveControlPlaneProfile(input);
  const previous = readProfiles();
  const profile = saveControlPlaneProfile({
    ...input,
    managementKey: '',
    managementKeyConfigured: Boolean(
      normalizeText(input.managementKey, 4096)
        || input.managementKeyConfigured
        || previous.find((item) => (
          item.stableServerId === normalizeStableServerId(input.stableServerId)
            || item.endpoint === normalizeControlPlaneEndpoint(String(input.endpoint || ''))
        ))
          ?.managementKeyConfigured
    )
  });
  try {
    const native = await upsertNativeServerProfile({
      id: profile.id,
      name: profile.name,
      endpoint: profile.endpoint,
      managementKey: normalizeText(input.managementKey, 4096) || undefined,
      metadata: createNativeProfileMetadata(profile)
    });
    const saved = mapNativeServerProfile(native);
    if (!saved) throw new Error('invalid_native_server_profile');
    writeProfiles([saved, ...readProfiles().filter((item) => item.id !== saved.id)]);
    return saved;
  } catch (error) {
    writeProfiles(previous);
    throw error;
  }
}

export function saveControlPlaneProfile(input: ControlPlaneProfileSaveInput): ControlPlaneProfile {
  const requestedRoutes = mergeServerRoutes(input.routes);
  const requestedRoute = selectProfileRoute(
    requestedRoutes,
    input.activeRouteId,
    input.endpoint
  );
  const endpointResolution = resolveControlPlaneProfileEndpointInput({
    ...input,
    endpoint: input.endpoint || requestedRoute?.endpoint || ''
  });
  const requestedEndpoint = endpointResolution.endpoint;
  const now = Date.now();
  const profiles = readProfiles();
  const suppliedStableServerId = normalizeStableServerId(
    input.stableServerId || endpointResolution.broker?.serverId
  );
  const existing = profiles.find((profile) => (
    (suppliedStableServerId && profile.stableServerId === suppliedStableServerId)
      || profile.endpoint === requestedEndpoint
      || profile.routes.some((route) => route.endpoint === requestedEndpoint)
  )) || null;
  const stableServerId = suppliedStableServerId
    || existing?.stableServerId
    || normalizeStableServerId('', requestedEndpoint);
  const descriptor = normalizeAnyDescriptor(input.descriptor) || existing?.descriptor || null;
  const lastError = normalizeText(input.lastError || '', 512);
  const nodes = input.nodes === undefined ? (existing?.nodes || []) : normalizeProfileNodes(input.nodes);
  const routes = mergeServerRoutes(
    existing?.routes,
    requestedRoutes,
    migrateLegacyServerRoutes({
      endpoint: requestedEndpoint,
      connectionMode: input.connectionMode || endpointResolution.connectionMode,
      broker: input.broker || endpointResolution.broker,
      state: input.state,
      routes: requestedRoutes
    })
  );
  const activeRoute = selectProfileRoute(
    routes,
    input.activeRouteId || (input.endpoint ? '' : existing?.activeRouteId),
    requestedEndpoint || existing?.endpoint
  );
  const endpoint = activeRoute?.endpoint || requestedEndpoint;
  const retainExistingConnectionMode = existing?.endpoint === endpoint
    ? existing.connectionMode
    : undefined;
  const connectionMode = normalizeProfileConnectionMode(
    input.connectionMode || retainExistingConnectionMode,
    endpoint
  );
  const broker = connectionMode === 'broker-proxy'
    ? normalizeProfileBroker(input.broker || endpointResolution.broker || existing?.broker, endpoint)
    : null;
  const suppliedManagementKey = normalizeText(input.managementKey, 4096);
  const managementKey = isNativeDesktopRuntime()
    ? ''
    : suppliedManagementKey || existing?.managementKey || '';
  const credentialRef = normalizeText(input.credentialRef || existing?.credentialRef || '', 256);
  const managementKeyConfigured = Boolean(
    input.managementKeyConfigured === true
      || suppliedManagementKey
      || existing?.managementKeyConfigured
      || existing?.managementKey
  );
  const state = inferProfileState({
    requestedState: input.state,
    existing,
    managementKey,
    managementKeyConfigured,
    lastError
  });
  const profile: ControlPlaneProfile = {
    id: existing?.id || stableProfileId(endpoint),
    stableServerId,
    name: normalizeText(input.name, 120) || existing?.name || descriptor?.endpoint || endpoint,
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
    nodeCount: Math.max(nodes.length, Number(input.nodeCount === undefined ? existing?.nodeCount : input.nodeCount) || 0),
    accountCount: Math.max(0, Number(input.accountCount === undefined ? existing?.accountCount : input.accountCount) || 0),
    activeAccountCount: Math.max(0, Number(input.activeAccountCount === undefined ? existing?.activeAccountCount : input.activeAccountCount) || 0),
    schedulableAccountCount: Math.max(0, Number(input.schedulableAccountCount === undefined ? existing?.schedulableAccountCount : input.schedulableAccountCount) || 0),
    sessionCount: Math.max(0, Number(input.sessionCount === undefined ? existing?.sessionCount : input.sessionCount) || 0),
    lastNodeSyncAt: Math.max(0, Number(input.lastNodeSyncAt === undefined ? existing?.lastNodeSyncAt : input.lastNodeSyncAt) || 0),
    lastStatusSyncAt: Math.max(0, Number(input.lastStatusSyncAt === undefined ? existing?.lastStatusSyncAt : input.lastStatusSyncAt) || 0),
    lastAccountsSyncAt: Math.max(0, Number(input.lastAccountsSyncAt === undefined ? existing?.lastAccountsSyncAt : input.lastAccountsSyncAt) || 0),
    lastSessionsSyncAt: Math.max(0, Number(input.lastSessionsSyncAt === undefined ? existing?.lastSessionsSyncAt : input.lastSessionsSyncAt) || 0),
    descriptor,
    lastCheckedAt: descriptor ? now : (existing?.lastCheckedAt || 0),
    lastError,
    createdAt: existing?.createdAt || now,
    updatedAt: now
  };
  const next = profiles.filter((item) => (
    item.id !== profile.id
      && item.stableServerId !== profile.stableServerId
      && item.endpoint !== profile.endpoint
  ));
  next.unshift(profile);
  writeProfiles(next);
  persistSharedControlPlaneProfile(profile);
  if (isNativeDesktopRuntime() && existing?.managementKeyConfigured) {
    upsertNativeServerProfile({
      id: profile.id,
      name: profile.name,
      endpoint: profile.endpoint,
      metadata: createNativeProfileMetadata(profile)
    }).catch(() => {});
  }
  return profile;
}

function createProfileApiClient(profile: Pick<ControlPlaneProfile, 'endpoint' | 'managementKey'>, options: {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
} = {}) {
  return createControlPlaneApiClient({
    endpoint: profile.endpoint,
    managementKey: profile.managementKey,
    timeoutMs: options.timeoutMs || DEFAULT_DEVICE_REQUEST_TIMEOUT_MS,
    fetchImpl: options.fetchImpl
  });
}

type ControlPlaneRequestProfile = Pick<ControlPlaneProfile, 'endpoint' | 'managementKey'>
  & Partial<Pick<ControlPlaneProfile, 'id' | 'managementKeyConfigured'>>;

function requireNativeProfileId(profile: ControlPlaneRequestProfile) {
  const profileId = normalizeText(profile.id, 96);
  if (!profileId) throw new Error('missing_native_server_profile_id');
  if (!hasConfiguredManagementKey(profile)) throw new Error('missing_management_key');
  return profileId;
}

async function fetchDeviceJson(profile: ControlPlaneRequestProfile, path: string, options: {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
} = {}) {
  if (isNativeServerTransportAvailable()) {
    const response = await requestNativeServerJson({
      profileId: requireNativeProfileId(profile),
      method: 'GET',
      path,
      timeoutMs: options.timeoutMs
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`control_plane_device_http_${response.status}`);
    }
    return response.data;
  }
  return createProfileApiClient(profile, options).getJson(path, {
    requireManagementKey: true,
    httpErrorPrefix: 'control_plane_device_http'
  });
}

async function postDeviceJson(profile: ControlPlaneRequestProfile, path: string, body: unknown, options: {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
} = {}) {
  if (isNativeServerTransportAvailable()) {
    const response = await requestNativeServerJson({
      profileId: requireNativeProfileId(profile),
      method: 'POST',
      path,
      body,
      timeoutMs: options.timeoutMs
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`control_plane_device_http_${response.status}`);
    }
    return response.data;
  }
  return createProfileApiClient(profile, options).postJson(path, body, {
    requireManagementKey: true,
    httpErrorPrefix: 'control_plane_device_http'
  });
}

export async function fetchControlPlaneDeviceNodes(profile: Pick<ControlPlaneProfile, 'endpoint' | 'managementKey'>, options: {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
} = {}): Promise<ControlPlaneNodeSummary[]> {
  const payload = await fetchDeviceJson(profile, '/v0/node-rpc/device-nodes', options);
  return normalizeDeviceNodes(payload);
}

export async function fetchControlPlaneDeviceStatus(profile: Pick<ControlPlaneProfile, 'endpoint' | 'managementKey'>, options: {
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

export async function fetchControlPlaneDeviceAccounts(profile: Pick<ControlPlaneProfile, 'endpoint' | 'managementKey'>, options: {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
} = {}) {
  const payload = await fetchDeviceJson(profile, '/v0/node-rpc/device-accounts', options);
  return normalizeDeviceAccounts(payload);
}

export async function fetchControlPlaneDeviceSessions(profile: Pick<ControlPlaneProfile, 'endpoint' | 'managementKey'>, options: {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
} = {}) {
  const payload = await fetchDeviceJson(profile, '/v0/node-rpc/device-sessions', options);
  return normalizeDeviceSessions(payload);
}

export async function fetchControlPlaneDeviceNodeSessions(
  profile: Pick<ControlPlaneProfile, 'endpoint' | 'managementKey'>,
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
  profile: Pick<ControlPlaneProfile, 'endpoint' | 'managementKey'>,
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
  profile: Pick<ControlPlaneProfile, 'endpoint' | 'managementKey'>,
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

export interface DeviceNodeSessionStartResult {
  ok: boolean;
  accepted: boolean;
  status: string;
  runId: string;
  sessionId: string;
}

/**
 * 起一个远端 node 会话（使用 Management Key 鉴权：POST device-node-session-start）。
 * 传 sessionId 可在同一 session 上续话。返回 runId 供拉取事件。
 */
export async function startControlPlaneDeviceNodeSession(
  profile: Pick<ControlPlaneProfile, 'endpoint' | 'managementKey'>,
  params: {
    nodeId: string;
    provider: string;
    projectPath: string;
    prompt: string;
    sessionId?: string;
    accountRef?: string;
    model?: string;
  },
  options: {
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
  } = {}
): Promise<DeviceNodeSessionStartResult> {
  const payload = await postDeviceJson(profile, '/v0/node-rpc/device-node-session-start', {
    nodeId: normalizeText(params.nodeId, 96),
    provider: normalizeText(params.provider, 64),
    projectPath: normalizeText(params.projectPath, 2048),
    prompt: String(params.prompt ?? ''),
    sessionId: normalizeText(params.sessionId, 96),
    accountRef: normalizeText(params.accountRef, 96),
    model: normalizeText(params.model, 96)
  }, options);
  const envelope = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
  const result = (envelope.result && typeof envelope.result === 'object'
    ? envelope.result
    : envelope) as Record<string, unknown>;
  return {
    ok: envelope.ok === undefined ? true : Boolean(envelope.ok),
    accepted: Boolean(result.accepted),
    status: normalizeText(result.status, 32),
    runId: normalizeText(result.runId, 96),
    sessionId: normalizeText(result.sessionId, 96)
  };
}

export interface DeviceNodeSessionRunEvent {
  type: string;
  text: string;
  sessionId: string;
}

export interface DeviceNodeSessionRunEventsResult {
  status: string;
  sessionId: string;
  events: DeviceNodeSessionRunEvent[];
}

/**
 * 拉取某个 run 的事件（GET device-node-session-run-events，nodeId 必填）。
 * delta/result 文本即模型回复；done 表示本轮结束。
 */
export async function fetchControlPlaneDeviceNodeSessionRunEvents(
  profile: Pick<ControlPlaneProfile, 'endpoint' | 'managementKey'>,
  nodeId: string,
  runId: string,
  options: {
    cursor?: number;
    limit?: number;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
  } = {}
): Promise<DeviceNodeSessionRunEventsResult> {
  const params = new URLSearchParams({
    nodeId: normalizeText(nodeId, 96),
    runId: normalizeText(runId, 96)
  });
  if (options.cursor !== undefined) params.set('cursor', String(options.cursor));
  params.set('limit', String(options.limit && options.limit > 0 ? options.limit : 100));
  const payload = await fetchDeviceJson(
    profile,
    `/v0/node-rpc/device-node-session-run-events?${params.toString()}`,
    options
  );
  const envelope = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
  const result = (envelope.result && typeof envelope.result === 'object'
    ? envelope.result
    : envelope) as Record<string, unknown>;
  const rawEvents = Array.isArray(result.events) ? result.events : [];
  const events: DeviceNodeSessionRunEvent[] = rawEvents.map((entry) => {
    const source = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
    const delta = typeof source.delta === 'string' ? source.delta : '';
    const content = typeof source.content === 'string' ? source.content : '';
    return {
      type: normalizeText(source.type, 40),
      text: delta || content,
      sessionId: normalizeText(source.sessionId, 96)
    };
  });
  return {
    status: normalizeText(result.status, 32),
    sessionId: normalizeText(result.sessionId, 96),
    events
  };
}

export async function sendControlPlaneDeviceNodeSessionInput(
  profile: Pick<ControlPlaneProfile, 'endpoint' | 'managementKey'>,
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
  profile: Pick<ControlPlaneProfile, 'endpoint' | 'managementKey'>,
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

function buildDeviceSessionStreamPath(
  sessionRef: string,
  options: { cursor?: number; limit?: number; intervalMs?: number } = {}
) {
  const ref = normalizeText(sessionRef, 96);
  const params = new URLSearchParams({ sessionRef: ref });
  if (options.cursor !== undefined) params.set('cursor', String(options.cursor));
  if (options.limit !== undefined) params.set('limit', String(options.limit));
  if (options.intervalMs !== undefined) params.set('intervalMs', String(options.intervalMs));
  return `/v0/node-rpc/device-session-stream?${params.toString()}`;
}

function buildDeviceNodeSessionStreamPath(
  nodeId: string,
  sessionRef: string,
  options: { cursor?: number; limit?: number; intervalMs?: number } = {}
) {
  const node = normalizeText(nodeId, 96);
  const ref = normalizeText(sessionRef, 96);
  const params = new URLSearchParams({ nodeId: node, sessionRef: ref });
  if (options.cursor !== undefined) params.set('cursor', String(options.cursor));
  if (options.limit !== undefined) params.set('limit', String(options.limit));
  if (options.intervalMs !== undefined) params.set('intervalMs', String(options.intervalMs));
  return `/v0/node-rpc/device-node-session-stream?${params.toString()}`;
}

async function consumeNativeControlPlaneEventStream(
  profile: ControlPlaneRequestProfile,
  path: string,
  onFrame: (frame: unknown) => void,
  options: { timeoutMs?: number; signal?: AbortSignal } = {}
) {
  const handle = await openNativeServerSse({
    profileId: requireNativeProfileId(profile),
    method: 'GET',
    path,
    timeoutMs: options.timeoutMs,
    signal: options.signal
  }, {
    onEvent: (event) => {
      const data = String(event.data || '').trim();
      if (!data || data === '[DONE]') return;
      onFrame(JSON.parse(data));
    }
  });
  await handle.done;
}

export function buildControlPlaneDeviceSessionStreamRequest(
  profile: Pick<ControlPlaneProfile, 'endpoint' | 'managementKey'>,
  sessionRef: string,
  options: {
    cursor?: number;
    limit?: number;
    intervalMs?: number;
    timeoutMs?: number;
  } = {}
): ControlPlaneEventStreamRequest {
  return createProfileApiClient(profile, options)
    .buildEventStreamRequest(buildDeviceSessionStreamPath(sessionRef, options), {
      requireManagementKey: true
    });
}

export function streamControlPlaneDeviceSessionEvents(
  profile: Pick<ControlPlaneProfile, 'endpoint' | 'managementKey'>,
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
  if (isNativeServerTransportAvailable()) {
    return consumeNativeControlPlaneEventStream(
      profile,
      buildDeviceSessionStreamPath(sessionRef, options),
      (frame) => {
        const normalized = normalizeDeviceSessionStreamFrame(frame);
        if (!normalized) throw new Error('invalid_control_plane_device_session_stream_frame');
        handlers.onFrame(normalized);
      },
      options
    );
  }
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
  profile: Pick<ControlPlaneProfile, 'endpoint' | 'managementKey'>,
  nodeId: string,
  sessionRef: string,
  options: {
    cursor?: number;
    limit?: number;
    intervalMs?: number;
    timeoutMs?: number;
  } = {}
): ControlPlaneEventStreamRequest {
  return createProfileApiClient(profile, options)
    .buildEventStreamRequest(buildDeviceNodeSessionStreamPath(nodeId, sessionRef, options), {
      requireManagementKey: true
    });
}

export function streamControlPlaneDeviceNodeSessionEvents(
  profile: Pick<ControlPlaneProfile, 'endpoint' | 'managementKey'>,
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
  if (isNativeServerTransportAvailable()) {
    return consumeNativeControlPlaneEventStream(
      profile,
      buildDeviceNodeSessionStreamPath(nodeId, sessionRef, options),
      (frame) => {
        const normalized = normalizeDeviceNodeSessionStreamFrame(frame);
        if (!normalized) {
          throw new Error('invalid_control_plane_device_node_session_stream_frame');
        }
        handlers.onFrame(normalized);
      },
      options
    );
  }
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

export async function fetchControlPlaneDescriptorForProfile(
  profile: ControlPlaneProfile,
  options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {}
): Promise<ControlPlaneDescriptor> {
  if (!isNativeServerTransportAvailable()) {
    return fetchControlPlaneDescriptor(profile.endpoint, options);
  }
  const response = await requestNativeServerJson<ControlPlaneDescriptorResponse | ControlPlaneDescriptor>({
    profileId: requireNativeProfileId(profile),
    method: 'GET',
    path: '/v0/fabric/descriptor',
    timeoutMs: options.timeoutMs
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`fabric_descriptor_http_${response.status}`);
  }
  const payload = response.data;
  const descriptor = normalizeAnyDescriptor('result' in payload ? payload.result : payload);
  if (!descriptor) throw new Error('invalid_fabric_descriptor');
  return {
    ...descriptor,
    endpoint: descriptor.endpoint || profile.endpoint
  };
}

export async function refreshControlPlaneDeviceState(profile: ControlPlaneProfile, options: {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
} = {}) {
  const [descriptor, nodes, status, accounts, sessions] = await Promise.all([
    fetchControlPlaneDescriptorForProfile(profile, options),
    fetchControlPlaneDeviceNodes(profile, options),
    fetchControlPlaneDeviceStatus(profile, options),
    fetchControlPlaneDeviceAccounts(profile, options),
    fetchControlPlaneDeviceSessions(profile, options)
  ]);
  const schedulableCount = Number(accounts.summary.bySchedulableStatus.schedulable) || 0;
  const now = Date.now();
  const nextProfile = await saveControlPlaneProfileSecure({
    name: profile.name,
    endpoint: profile.endpoint,
    descriptor,
    state: 'ready',
    managementKey: profile.managementKey,
    credentialRef: profile.credentialRef,
    managementKeyConfigured: profile.managementKeyConfigured,
    nodes,
    nodeCount: nodes.length,
    accountCount: status.totalAccounts,
    activeAccountCount: status.activeAccounts,
    schedulableAccountCount: schedulableCount,
    sessionCount: sessions.summary.total,
    lastNodeSyncAt: now,
    lastStatusSyncAt: now,
    lastAccountsSyncAt: now,
    lastSessionsSyncAt: now,
    lastError: ''
  });
  return {
    profile: nextProfile,
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
      const failedProfile = await saveControlPlaneProfileSecure({
        name: profile.name,
        endpoint: profile.endpoint,
        descriptor: profile.descriptor,
        state: 'degraded',
        managementKey: profile.managementKey,
        credentialRef: profile.credentialRef,
        managementKeyConfigured: profile.managementKeyConfigured,
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

export async function removeControlPlaneProfileSecure(profileId: string) {
  const id = normalizeText(profileId, 96);
  let nativeActiveProfileId = '';
  if (isNativeDesktopRuntime() && id) {
    const result = await removeNativeServerProfile(id);
    nativeActiveProfileId = result.activeProfileId;
  }
  const profiles = removeControlPlaneProfile(id);
  if (isNativeDesktopRuntime() && !nativeActiveProfileId && profiles.length > 0) {
    nativeActiveProfileId = profiles.find(isReadyProfileCandidate)?.id || profiles[0].id;
    await setActiveNativeServerProfile(nativeActiveProfileId);
  }
  return profiles;
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
