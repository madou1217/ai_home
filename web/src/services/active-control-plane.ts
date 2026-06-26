import type { ControlPlaneProfile } from '@/types';
import type { ControlPlaneEventStreamFetch } from './control-plane-api-client';
import {
  buildControlPlaneDeviceNodeSessionStreamRequest,
  buildControlPlaneDeviceSessionStreamRequest,
  fetchControlPlaneDeviceAccounts,
  fetchControlPlaneDeviceNodes,
  fetchControlPlaneDeviceNodeSessions,
  fetchControlPlaneDeviceNodeSessionMessages,
  fetchControlPlaneDeviceSessionEvents,
  fetchControlPlaneDeviceSessionMessages,
  fetchControlPlaneDeviceSessions,
  listControlPlaneProfiles,
  refreshControlPlaneDeviceState,
  saveControlPlaneProfile,
  sendControlPlaneDeviceNodeSessionInput,
  streamControlPlaneDeviceNodeSessionEvents,
  streamControlPlaneDeviceSessionEvents
} from './control-plane-profiles';
import {
  getActiveControlPlaneProfileId,
  resolveActiveControlPlaneProfile,
  resolveStoredActiveControlPlaneProfile,
  type ActiveControlPlaneResolution
} from './control-plane-selection';

export type ActiveControlPlaneUnavailableReason =
  | 'ready'
  | 'missing'
  | 'revoked'
  | 'unpaired'
  | 'missing-token';

export interface ActiveControlPlaneContext extends ActiveControlPlaneResolution {
  ready: boolean;
  reason: ActiveControlPlaneUnavailableReason;
}

function normalizeText(value: unknown, maxLength = 512) {
  const text = String(value ?? '').trim();
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function getUnavailableReason(profile: ControlPlaneProfile | null): ActiveControlPlaneUnavailableReason {
  if (!profile) return 'missing';
  if (profile.state === 'revoked') return 'revoked';
  if (profile.authState !== 'paired') return 'unpaired';
  if (!normalizeText(profile.deviceToken, 4096)) return 'missing-token';
  return 'ready';
}

function createActiveControlPlaneError(reason: ActiveControlPlaneUnavailableReason) {
  const errorCode = reason === 'missing'
    ? 'missing_active_control_plane_profile'
    : reason === 'revoked'
      ? 'active_control_plane_revoked'
      : reason === 'unpaired'
        ? 'active_control_plane_unpaired'
        : 'missing_control_plane_device_token';
  const error = new Error(errorCode);
  (error as Error & { code?: string }).code = errorCode;
  return error;
}

function normalizeSyncError(error: unknown) {
  const source = error as { code?: string; message?: string };
  return normalizeText(source?.code || source?.message || error || 'control_plane_sync_failed');
}

function schedulableAccountCount(summary: { bySchedulableStatus?: Record<string, number> }) {
  return Math.max(0, Number(summary.bySchedulableStatus?.schedulable) || 0);
}

type ActiveControlPlaneProfileSuccessPatch = Partial<Pick<
  ControlPlaneProfile,
  | 'nodes'
  | 'nodeCount'
  | 'accountCount'
  | 'activeAccountCount'
  | 'schedulableAccountCount'
  | 'sessionCount'
  | 'lastDeviceSyncAt'
  | 'lastAccountsSyncAt'
  | 'lastSessionsSyncAt'
>>;

function resolveActiveControlPlaneRequest() {
  const context = resolveStoredActiveControlPlaneContext();
  const profile = requireActiveControlPlaneProfile(context);
  return { context, profile };
}

async function runActiveControlPlaneRequest<T>(
  handler: (profile: ControlPlaneProfile, context: ActiveControlPlaneContext) => Promise<T>
): Promise<T> {
  const { context, profile } = resolveActiveControlPlaneRequest();
  try {
    return await handler(profile, context);
  } catch (error) {
    markActiveControlPlaneProfileDegraded(profile, error);
    throw error;
  }
}

function saveActiveControlPlaneProfileSuccess(
  profile: ControlPlaneProfile,
  patch: ActiveControlPlaneProfileSuccessPatch = {}
) {
  return saveControlPlaneProfile({
    name: profile.name,
    endpoint: profile.endpoint,
    descriptor: profile.descriptor,
    state: 'paired',
    authState: 'paired',
    deviceToken: profile.deviceToken,
    lastError: '',
    ...patch
  });
}

function withActiveControlPlaneMetadata<T extends Record<string, unknown>>(
  profile: ControlPlaneProfile,
  context: ActiveControlPlaneContext,
  payload: T
) {
  return {
    ...payload,
    activeProfileId: profile.id,
    activeProfileSource: context.source
  };
}

export function getActiveControlPlaneUnavailableText(
  input: ActiveControlPlaneContext | ActiveControlPlaneUnavailableReason
) {
  const reason = typeof input === 'string' ? input : input.reason;
  if (reason === 'missing') return '未选择 Control Plane';
  if (reason === 'revoked') return '当前设备已撤销';
  if (reason === 'unpaired') return '当前 Control Plane 未配对';
  if (reason === 'missing-token') return '缺少设备令牌';
  return '';
}

function createActiveControlPlaneContext(resolution: ActiveControlPlaneResolution): ActiveControlPlaneContext {
  const reason = getUnavailableReason(resolution.profile);
  return {
    ...resolution,
    ready: reason === 'ready',
    reason
  };
}

export function resolveActiveControlPlaneContext(
  profiles?: ControlPlaneProfile[],
  profileId?: string
): ActiveControlPlaneContext {
  const sourceProfiles = Array.isArray(profiles) ? profiles : listControlPlaneProfiles();
  const resolution = profileId === undefined
    ? resolveStoredActiveControlPlaneProfile(sourceProfiles, getActiveControlPlaneProfileId())
    : resolveActiveControlPlaneProfile(sourceProfiles, profileId);
  return createActiveControlPlaneContext(resolution);
}

export function resolveStoredActiveControlPlaneContext(
  profiles = listControlPlaneProfiles(),
  storedProfileId = getActiveControlPlaneProfileId()
): ActiveControlPlaneContext {
  return createActiveControlPlaneContext(resolveStoredActiveControlPlaneProfile(profiles, storedProfileId));
}

export function isActiveControlPlaneResultCurrent(
  result: { activeProfileId?: unknown } | null | undefined,
  profiles?: ControlPlaneProfile[],
  profileId?: string
): boolean {
  const activeProfileId = normalizeText(result?.activeProfileId, 96);
  if (!activeProfileId) return false;
  const sourceProfiles = Array.isArray(profiles) ? profiles : listControlPlaneProfiles();
  const resolution = profileId === undefined
    ? resolveStoredActiveControlPlaneProfile(sourceProfiles, getActiveControlPlaneProfileId())
    : resolveActiveControlPlaneProfile(sourceProfiles, profileId);
  return resolution.profileId === activeProfileId;
}

export function requireActiveControlPlaneProfile(
  context = resolveStoredActiveControlPlaneContext()
): ControlPlaneProfile {
  if (context.profile && context.ready) {
    return context.profile;
  }
  throw createActiveControlPlaneError(context.reason);
}

export function markActiveControlPlaneProfileDegraded(
  profile: ControlPlaneProfile,
  error: unknown
): ControlPlaneProfile {
  return saveControlPlaneProfile({
    name: profile.name,
    endpoint: profile.endpoint,
    descriptor: profile.descriptor,
    state: 'degraded',
    authState: profile.authState,
    deviceToken: profile.deviceToken,
    lastError: normalizeSyncError(error)
  });
}

export async function refreshActiveControlPlaneDeviceState(options: {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
} = {}) {
  return runActiveControlPlaneRequest(async (profile, context) => {
    const snapshot = await refreshControlPlaneDeviceState(profile, options);
    return {
      ...snapshot,
      activeProfileId: snapshot.profile.id,
      activeProfileSource: context.source
    };
  });
}

export async function readActiveControlPlaneDeviceNodes(options: {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
} = {}) {
  return runActiveControlPlaneRequest(async (profile, context) => {
    const nodes = await fetchControlPlaneDeviceNodes(profile, options);
    const nextProfile = saveActiveControlPlaneProfileSuccess(profile, {
      nodes,
      nodeCount: nodes.length,
      lastDeviceSyncAt: Date.now()
    });
    return withActiveControlPlaneMetadata(nextProfile, context, {
      profile: nextProfile,
      nodes
    });
  });
}

export async function readActiveControlPlaneDeviceAccounts(options: {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
} = {}) {
  return runActiveControlPlaneRequest(async (profile, context) => {
    const accounts = await fetchControlPlaneDeviceAccounts(profile, options);
    const nextProfile = saveActiveControlPlaneProfileSuccess(profile, {
      accountCount: accounts.summary.total,
      activeAccountCount: accounts.summary.active,
      schedulableAccountCount: schedulableAccountCount(accounts.summary),
      lastAccountsSyncAt: Date.now()
    });
    return withActiveControlPlaneMetadata(nextProfile, context, {
      profile: nextProfile,
      accounts: accounts.accounts,
      accountSummary: accounts.summary
    });
  });
}

export async function readActiveControlPlaneDeviceSessions(options: {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
} = {}) {
  return runActiveControlPlaneRequest(async (profile, context) => {
    const sessions = await fetchControlPlaneDeviceSessions(profile, options);
    const nextProfile = saveActiveControlPlaneProfileSuccess(profile, {
      sessionCount: sessions.summary.total,
      lastSessionsSyncAt: Date.now()
    });
    return withActiveControlPlaneMetadata(nextProfile, context, {
      profile: nextProfile,
      sessions: sessions.sessions,
      sessionSummary: sessions.summary
    });
  });
}

export async function readActiveControlPlaneDeviceSessionMessages(sessionRef: string, options: {
  limit?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
} = {}) {
  return runActiveControlPlaneRequest(async (profile, context) => {
    const messages = await fetchControlPlaneDeviceSessionMessages(profile, sessionRef, options);
    const nextProfile = saveActiveControlPlaneProfileSuccess(profile, {
      lastSessionsSyncAt: Date.now(),
    });
    return withActiveControlPlaneMetadata(nextProfile, context, {
      profile: nextProfile,
      session: messages.session,
      messages: messages.messages,
      messageSummary: messages.summary
    });
  });
}

export async function readActiveControlPlaneDeviceNodeSessions(nodeId: string, options: {
  limit?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
} = {}) {
  return runActiveControlPlaneRequest(async (profile, context) => {
    const sessions = await fetchControlPlaneDeviceNodeSessions(profile, nodeId, options);
    const nextProfile = saveActiveControlPlaneProfileSuccess(profile, {
      lastSessionsSyncAt: Date.now(),
    });
    return withActiveControlPlaneMetadata(nextProfile, context, {
      profile: nextProfile,
      nodeId: sessions.nodeId,
      sessions: sessions.sessions,
      sessionSummary: sessions.summary
    });
  });
}

export async function readActiveControlPlaneDeviceNodeSessionMessages(nodeId: string, sessionRef: string, options: {
  limit?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
} = {}) {
  return runActiveControlPlaneRequest(async (profile, context) => {
    const messages = await fetchControlPlaneDeviceNodeSessionMessages(profile, nodeId, sessionRef, options);
    const nextProfile = saveActiveControlPlaneProfileSuccess(profile, {
      lastSessionsSyncAt: Date.now(),
    });
    return withActiveControlPlaneMetadata(nextProfile, context, {
      profile: nextProfile,
      nodeId: messages.nodeId,
      session: messages.session,
      messages: messages.messages,
      messageSummary: messages.summary
    });
  });
}

export async function sendActiveControlPlaneDeviceNodeSessionInput(nodeId: string, sessionRef: string, input: string, options: {
  appendNewline?: boolean;
  promptId?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
} = {}) {
  return runActiveControlPlaneRequest(async (profile, context) => {
    const result = await sendControlPlaneDeviceNodeSessionInput(profile, nodeId, sessionRef, input, options);
    const nextProfile = saveActiveControlPlaneProfileSuccess(profile, {
      lastSessionsSyncAt: Date.now(),
    });
    return withActiveControlPlaneMetadata(nextProfile, context, {
      profile: nextProfile,
      nodeId: result.nodeId,
      session: result.session,
      accepted: result.accepted,
      appendNewline: result.appendNewline,
      promptId: result.promptId
    });
  });
}

export async function readActiveControlPlaneDeviceSessionEvents(sessionRef: string, options: {
  cursor?: number;
  limit?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
} = {}) {
  return runActiveControlPlaneRequest(async (profile, context) => {
    const events = await fetchControlPlaneDeviceSessionEvents(profile, sessionRef, options);
    const nextProfile = saveActiveControlPlaneProfileSuccess(profile, {
      lastSessionsSyncAt: Date.now(),
    });
    return withActiveControlPlaneMetadata(nextProfile, context, {
      profile: nextProfile,
      session: events.session,
      events: events.events,
      cursor: events.cursor,
      requiresSnapshot: events.requiresSnapshot,
      truncated: events.truncated
    });
  });
}

export function buildActiveControlPlaneDeviceSessionStreamRequest(sessionRef: string, options: {
  cursor?: number;
  limit?: number;
  intervalMs?: number;
} = {}) {
  const { context, profile } = resolveActiveControlPlaneRequest();
  return {
    ...buildControlPlaneDeviceSessionStreamRequest(profile, sessionRef, options),
    activeProfileId: profile.id,
    activeProfileSource: context.source
  };
}

export function streamActiveControlPlaneDeviceSessionEvents(sessionRef: string, handlers: {
  onFrame: Parameters<typeof streamControlPlaneDeviceSessionEvents>[2]['onFrame'];
}, options: {
  cursor?: number;
  limit?: number;
  intervalMs?: number;
  signal?: AbortSignal;
  fetchImpl?: ControlPlaneEventStreamFetch;
} = {}) {
  const { profile } = resolveActiveControlPlaneRequest();
  return streamControlPlaneDeviceSessionEvents(profile, sessionRef, handlers, options);
}

export function buildActiveControlPlaneDeviceNodeSessionStreamRequest(nodeId: string, sessionRef: string, options: {
  cursor?: number;
  limit?: number;
  intervalMs?: number;
} = {}) {
  const { context, profile } = resolveActiveControlPlaneRequest();
  return {
    ...buildControlPlaneDeviceNodeSessionStreamRequest(profile, nodeId, sessionRef, options),
    activeProfileId: profile.id,
    activeProfileSource: context.source
  };
}

export function streamActiveControlPlaneDeviceNodeSessionEvents(nodeId: string, sessionRef: string, handlers: {
  onFrame: Parameters<typeof streamControlPlaneDeviceNodeSessionEvents>[3]['onFrame'];
}, options: {
  cursor?: number;
  limit?: number;
  intervalMs?: number;
  signal?: AbortSignal;
  fetchImpl?: ControlPlaneEventStreamFetch;
} = {}) {
  const { profile } = resolveActiveControlPlaneRequest();
  return streamControlPlaneDeviceNodeSessionEvents(profile, nodeId, sessionRef, handlers, options);
}
