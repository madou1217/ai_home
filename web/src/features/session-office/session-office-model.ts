import type { TerminalDirectorySession } from '@/services/api';
import type { WebTerminalTab } from '@/features/web-terminal/web-terminal-context';
import {
  buildReadableMailPresentation,
  buildReadablePartySummary,
  evaluateMailLifecycle,
} from './peer-message-presentation';
import type {
  EmployeeVisualPersona,
  EnrichedPeerMessage,
  MailboxFolder,
  MailboxReplyFilter,
  MailboxScope,
  OfficeProjectRoom,
  OfficeSessionItem,
  PeerCounts,
  PeerDeliveryState,
  PeerMessageRecord,
  PeerNotificationState,
  PeerParty,
  PeerReplyPolicy,
  PeerThreadGroup,
  ResolvedPeerEndpoint,
  SessionActivityCue,
  SessionAvailability,
} from './session-office-types';

export const NO_CWD_PROJECT_KEY = '__no_cwd__';

export interface SessionPreviewCacheEntry {
  model?: string;
  preview?: string;
}

export interface BuildOfficeWorkspaceInput {
  serverId: string;
  directorySessions: TerminalDirectorySession[];
  interactiveTabs: WebTerminalTab[];
  unavailableTabs: WebTerminalTab[];
  hiddenSessionKeys: ReadonlySet<string>;
  rawMessages: PeerMessageRecord[];
  previewsByCacheKey: ReadonlyMap<string, SessionPreviewCacheEntry>;
  recentPulseSessionKeys: ReadonlySet<string>;
  query: string;
  providerFilter: string;
}

export interface OfficeWorkspaceSnapshot {
  rooms: OfficeProjectRoom[];
  filteredRooms: OfficeProjectRoom[];
  allSessions: OfficeSessionItem[];
  unavailableSessions: OfficeSessionItem[];
  providerOptions: string[];
  peerMessages: EnrichedPeerMessage[];
  unassignedMessages: EnrichedPeerMessage[];
  fullyUnassignedCount: number;
}

export interface SessionMailboxViewResult {
  filteredMessages: EnrichedPeerMessage[];
  threads: PeerThreadGroup[];
  inboxCount: number;
  sentCount: number;
  allCount: number;
  threadCount: number;
  undeliveredCount: number;
  staleCount: number;
  deliveredOrReadCount: number;
  attentionCount: number;
  replyRequiredCount: number;
  noReplyCount: number;
  threadedMsgCount: number;
  unspecifiedReplyCount: number;
}

const AVATAR_TONES = [
  '#4f8ff7',
  '#38bdf8',
  '#34d399',
  '#a78bfa',
  '#f59e0b',
  '#f472b6',
  '#2dd4bf',
  '#fb7185',
] as const;

const DESK_ACCENTS = [
  '#3b82f6',
  '#06b6d4',
  '#10b981',
  '#8b5cf6',
  '#f59e0b',
  '#ec4899',
] as const;

const VISOR_STYLES: ReadonlyArray<EmployeeVisualPersona['visorStyle']> = [
  'visor',
  'glasses',
  'headset',
];

function hashString(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * Normalizes a workspace path into a stable room key.
 * Preserves the full normalized directory path so distinct paths sharing a
 * basename never merge into one room.
 */
export function normalizeProjectPath(rawCwd: string | undefined | null): string {
  const normalized = String(rawCwd ?? '').trim().replace(/\\/g, '/');
  if (!normalized) return NO_CWD_PROJECT_KEY;
  if (/^\/+$/.test(normalized)) return '/';
  if (/^[A-Za-z]:\/+$/.test(normalized)) return `${normalized[0]}:/`;
  const stripped = normalized.replace(/\/+$/, '');
  return stripped || '/';
}

export function extractProjectDisplayName(projectKey: string): string {
  if (!projectKey || projectKey === NO_CWD_PROJECT_KEY) return '未指定目录';
  if (projectKey === '/') return '/';
  if (/^[A-Za-z]:\/$/.test(projectKey)) return projectKey;
  const parts = projectKey.split('/').filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : projectKey;
}

export function buildPreviewCacheKey(
  serverId: string,
  provider: string,
  nativeSessionId: string,
  cwd: string,
): string {
  return `${serverId}:${provider}:${nativeSessionId}:${cwd}`;
}

export function formatOfficeTimestamp(ms: number): string {
  if (!ms || !Number.isFinite(ms) || ms <= 0) return '-';
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return '-';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function normalizePeerParty(raw: unknown): PeerParty {
  const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    channel: String(source.channel ?? '').trim(),
    provider: String(source.provider ?? '').trim(),
    name: String(source.name ?? '').trim(),
    address: String(source.address ?? '').trim(),
    sessionId: String(source.sessionId ?? '').trim(),
  };
}

function readOptionalTrimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function readOptionalPositiveTimestamp(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return undefined;
  return num;
}

function readOptionalNonNegativeInt(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return undefined;
  return Math.trunc(num);
}

export function normalizePeerMessageRecord(raw: unknown): PeerMessageRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const id = String(record.id ?? '').trim();
  if (!id) return null;
  const shortId = String(record.shortId ?? '').trim() || id.slice(0, 11);
  const replyTo = String(record.replyTo ?? '').trim();
  const replyToShort = String(record.replyToShort ?? '').trim() || (replyTo ? replyTo.slice(0, 11) : '');
  const receiptError = readOptionalTrimmedString(record.receiptError);
  const subject = readOptionalTrimmedString(record.subject);
  const summary = readOptionalTrimmedString(record.summary);
  const purpose = readOptionalTrimmedString(record.purpose);
  const action = readOptionalTrimmedString(record.action);
  const replyPolicyRaw = readOptionalTrimmedString(record.replyPolicy);
  const autoDeliverUntil = readOptionalPositiveTimestamp(record.autoDeliverUntil);
  const expiresAtRaw = record.expiresAt;
  const expiresAt = expiresAtRaw === 0 || expiresAtRaw === '0'
    ? 0
    : readOptionalPositiveTimestamp(expiresAtRaw);
  const canceledAt = readOptionalPositiveTimestamp(record.canceledAt);
  const supersedes = readOptionalTrimmedString(record.supersedes);
  const notificationStateRaw = readOptionalTrimmedString(record.notificationState);
  const waitingReason = readOptionalTrimmedString(record.waitingReason);
  const busySince = readOptionalPositiveTimestamp(record.busySince);
  const probeCount = readOptionalNonNegativeInt(record.probeCount);
  const priority = Number(record.priority) || 0;

  return {
    id,
    shortId,
    from: normalizePeerParty(record.from),
    to: normalizePeerParty(record.to),
    replyTo,
    replyToShort,
    body: String(record.body ?? ''),
    state: (String(record.state ?? '').trim() || 'pending') as PeerDeliveryState,
    createdAt: Number(record.createdAt) || 0,
    deliveredAt: Number(record.deliveredAt) || 0,
    readAt: Number(record.readAt) || 0,
    nextAttemptAt: Number(record.nextAttemptAt) || 0,
    attemptCount: Number(record.attemptCount) || 0,
    error: String(record.error ?? ''),
    lastAttemptError: String(record.lastAttemptError ?? ''),
    ...(receiptError ? { receiptError } : {}),
    ...(subject ? { subject } : {}),
    ...(summary ? { summary } : {}),
    ...(purpose ? { purpose } : {}),
    ...(action ? { action } : {}),
    ...(replyPolicyRaw ? { replyPolicy: replyPolicyRaw as PeerReplyPolicy } : {}),
    ...(autoDeliverUntil !== undefined ? { autoDeliverUntil } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(canceledAt !== undefined ? { canceledAt } : {}),
    ...(supersedes ? { supersedes } : {}),
    ...(notificationStateRaw ? { notificationState: notificationStateRaw as PeerNotificationState } : {}),
    ...(waitingReason ? { waitingReason } : {}),
    ...(busySince !== undefined ? { busySince } : {}),
    ...(probeCount !== undefined ? { probeCount } : {}),
    ...(priority ? { priority } : {}),
  };
}

function isRecordActivelyPending(msg: PeerMessageRecord): boolean {
  const notif = String(msg.notificationState ?? '').trim().toLowerCase();
  if (notif === 'canceled' || notif === 'expired' || notif === 'delivered') {
    return false;
  }
  if (msg.canceledAt && msg.canceledAt > 0) {
    return false;
  }
  if (msg.deliveredAt > 0 || msg.readAt > 0) {
    return false;
  }
  return msg.state === 'pending' || notif === 'waiting' || notif === 'ready';
}

/** 需要人工关注的消息数（未送达、待人工、异常），用于「消息」入口的轻量徽标。 */
export function countAttentionPeerMessages(
  messages: EnrichedPeerMessage[],
  nowMs: number = Date.now(),
): number {
  let count = 0;
  for (const msg of messages) {
    if (evaluateMailLifecycle(msg, nowMs).isAttention) count += 1;
  }
  return count;
}

export function computePeerCounts(messages: PeerMessageRecord[]): PeerCounts {
  const counts: PeerCounts = {
    total: messages.length,
    pending: 0,
    delivered: 0,
    read: 0,
    failed: 0,
  };
  for (const msg of messages) {
    const notif = String(msg.notificationState ?? '').trim().toLowerCase();
    if (msg.state === 'read' || msg.readAt > 0) {
      counts.read += 1;
    } else if (msg.state === 'delivered' || notif === 'delivered' || msg.deliveredAt > 0) {
      counts.delivered += 1;
    } else if (msg.state === 'failed') {
      counts.failed += 1;
    } else if (isRecordActivelyPending(msg)) {
      counts.pending += 1;
    }
  }
  return counts;
}

function buildShortSessionLabel(label: string, projectName: string, kind: 'account-cli' | 'shell'): string {
  const trimmed = label.trim();
  if (!trimmed) return kind === 'shell' ? 'Shell' : 'Session';
  if (trimmed.includes(' · ')) {
    const parts = trimmed.split(' · ').map((part) => part.trim()).filter(Boolean);
    if (parts.length >= 3 && parts[1] === projectName) {
      return `${parts[0]} · ${parts[parts.length - 1]}`;
    }
    if (parts.length >= 2) {
      const compact = `${parts[0]} · ${parts[parts.length - 1]}`;
      return compact.length <= 26 ? compact : `${compact.slice(0, 25)}…`;
    }
  }
  if (trimmed.startsWith('/') || trimmed.startsWith('\\')) {
    const segs = trimmed.split(/[\\/]+/).filter(Boolean);
    const leaf = segs.length > 0 ? segs[segs.length - 1] : trimmed;
    return leaf.length <= 24 ? leaf : `${leaf.slice(0, 23)}…`;
  }
  return trimmed.length <= 26 ? trimmed : `${trimmed.slice(0, 25)}…`;
}

function deriveBadgeCode(provider: string, kind: 'account-cli' | 'shell', seatIndex: number): string {
  const norm = provider.trim().toLowerCase();
  const prefixMap: Record<string, string> = {
    claude: 'CLD',
    codex: 'CDX',
    codexchat: 'CDC',
    codebuddy: 'CBD',
    codebuddycn: 'CBC',
    workbuddy: 'WBD',
    workbuddycn: 'WBC',
    gemini: 'GMI',
    agy: 'AGY',
    opencode: 'OPC',
    grok: 'GRK',
    qoder: 'QDR',
    qodercn: 'QDC',
    cline: 'CLN',
    zcode: 'ZCD',
    kimi: 'KMI',
    kiro: 'KRO',
    shell: 'SHL',
  };
  const prefix = prefixMap[norm] || (kind === 'shell' ? 'SHL' : (norm.slice(0, 3).toUpperCase() || 'SES'));
  return `${prefix}-${String(seatIndex + 1).padStart(2, '0')}`;
}

function createInitialPersona(
  sessionKey: string,
  provider: string,
  kind: 'account-cli' | 'shell',
  availability: SessionAvailability,
  seatIndex: number,
): EmployeeVisualPersona {
  const hash = hashString(sessionKey);
  const providerHash = hashString(provider || kind);
  return {
    avatarTone: AVATAR_TONES[hash % AVATAR_TONES.length],
    visorStyle: VISOR_STYLES[(hash >>> 3) % VISOR_STYLES.length],
    posture: availability === 'interactive' ? 'typing' : 'monitoring',
    deskAccent: DESK_ACCENTS[(providerHash + seatIndex) % DESK_ACCENTS.length],
    badgeCode: deriveBadgeCode(provider, kind, seatIndex),
    seatIndex,
  };
}

function createEmptyActivity(recentPulse: boolean): SessionActivityCue {
  return {
    kind: 'idle',
    pendingCount: 0,
    unreadOrDeliveredCount: 0,
    failedCount: 0,
    lastMessageAt: 0,
    recentPulse,
    latestSnippet: '',
  };
}

function resolveThreadRoots(messages: PeerMessageRecord[]): Map<string, string> {
  const byId = new Map<string, PeerMessageRecord>();
  const byShortId = new Map<string, PeerMessageRecord>();
  const duplicateShorts = new Set<string>();

  for (const msg of messages) {
    byId.set(msg.id, msg);
    if (msg.shortId) {
      if (byShortId.has(msg.shortId)) {
        duplicateShorts.add(msg.shortId);
      } else {
        byShortId.set(msg.shortId, msg);
      }
    }
  }
  for (const dup of duplicateShorts) {
    byShortId.delete(dup);
  }

  const findParent = (refId: string, refShort: string): PeerMessageRecord | undefined => {
    if (refId) {
      const exact = byId.get(refId) ?? byShortId.get(refId);
      if (exact) return exact;
    }
    if (refShort) {
      return byShortId.get(refShort);
    }
    return undefined;
  };

  const roots = new Map<string, string>();
  for (const msg of messages) {
    if (!msg.replyTo && !msg.replyToShort) {
      roots.set(msg.id, msg.id);
      continue;
    }
    const visited = new Set<string>([msg.id]);
    let cursorId = msg.replyTo;
    let cursorShort = msg.replyToShort;
    let rootId = msg.id;
    while (cursorId || cursorShort) {
      const parent = findParent(cursorId, cursorShort);
      if (!parent) {
        rootId = cursorId || cursorShort || rootId;
        break;
      }
      if (visited.has(parent.id)) {
        break;
      }
      visited.add(parent.id);
      rootId = parent.id;
      cursorId = parent.replyTo;
      cursorShort = parent.replyToShort;
    }
    roots.set(msg.id, rootId);
  }
  return roots;
}

function sameExactPartyIdentity(a: PeerParty, b: PeerParty): boolean {
  const aKey = [a.channel, a.provider, a.sessionId || a.address || a.name]
    .map((part) => part.trim().toLowerCase())
    .join('\0');
  const bKey = [b.channel, b.provider, b.sessionId || b.address || b.name]
    .map((part) => part.trim().toLowerCase())
    .join('\0');
  return Boolean(aKey.replace(/\0/g, '')) && aKey === bKey;
}

function resolveSupersededByMap(messages: PeerMessageRecord[]): Map<string, string[]> {
  const byId = new Map<string, PeerMessageRecord>();
  const byShort = new Map<string, PeerMessageRecord>();
  for (const msg of messages) {
    byId.set(msg.id, msg);
    if (msg.shortId && !byShort.has(msg.shortId)) {
      byShort.set(msg.shortId, msg);
    }
  }

  const supersededMap = new Map<string, string[]>();
  for (const newer of messages) {
    const targetRef = String(newer.supersedes ?? '').trim();
    if (!targetRef) continue;
    const older = byId.get(targetRef) ?? byShort.get(targetRef);
    if (!older || older.id === newer.id) continue;
    if (!sameExactPartyIdentity(older.from, newer.from) || !sameExactPartyIdentity(older.to, newer.to)) {
      continue;
    }
    const bucket = supersededMap.get(older.id);
    const newerLabel = newer.shortId || newer.id.slice(0, 8);
    if (bucket) {
      if (!bucket.includes(newerLabel)) bucket.push(newerLabel);
    } else {
      supersededMap.set(older.id, [newerLabel]);
    }
  }
  return supersededMap;
}

interface SessionLookupIndex {
  bySessionKey: Map<string, OfficeSessionItem>;
  byNativeId: Map<string, OfficeSessionItem[]>;
}

function buildSessionLookupIndex(sessions: OfficeSessionItem[]): SessionLookupIndex {
  const bySessionKey = new Map<string, OfficeSessionItem>();
  const byNativeId = new Map<string, OfficeSessionItem[]>;
  for (const session of sessions) {
    bySessionKey.set(session.sessionKey, session);
    const nativeId = String(session.nativeSessionId || '').trim();
    if (nativeId) {
      const bucket = byNativeId.get(nativeId);
      if (bucket) bucket.push(session);
      else byNativeId.set(nativeId, [session]);
    }
  }
  return { bySessionKey, byNativeId };
}

function formatUnresolvedDisplayName(party: PeerParty): string {
  const base = party.name || party.address || party.sessionId || '外部终端';
  return party.provider ? `${party.provider} · ${base}` : base;
}

function matchSessionStrictly(
  party: PeerParty,
  index: SessionLookupIndex,
): { session: OfficeSessionItem | null; matchBasis: ResolvedPeerEndpoint['matchBasis'] } {
  const rawSessionId = String(party.sessionId || '').trim();
  if (!rawSessionId) {
    return { session: null, matchBasis: 'unresolved' };
  }

  const byKey = index.bySessionKey.get(rawSessionId);
  if (byKey) {
    return { session: byKey, matchBasis: 'sessionKey' };
  }

  const nativeMatches = index.byNativeId.get(rawSessionId);
  if (!nativeMatches || nativeMatches.length === 0) {
    return { session: null, matchBasis: 'unresolved' };
  }
  if (nativeMatches.length === 1) {
    return { session: nativeMatches[0], matchBasis: 'nativeSessionId' };
  }

  const partyProvider = party.provider.trim().toLowerCase();
  if (partyProvider) {
    const providerFiltered = nativeMatches.filter(
      (item) => item.provider.trim().toLowerCase() === partyProvider,
    );
    if (providerFiltered.length === 1) {
      return { session: providerFiltered[0], matchBasis: 'nativeSessionId' };
    }
  }

  return { session: null, matchBasis: 'unresolved' };
}

function resolvePeerEndpoint(
  party: PeerParty,
  index: SessionLookupIndex,
): ResolvedPeerEndpoint {
  const { session, matchBasis } = matchSessionStrictly(party, index);
  if (!session || matchBasis === 'unresolved') {
    return {
      party,
      displayName: formatUnresolvedDisplayName(party),
      sessionKey: null,
      sessionId: party.sessionId || null,
      sessionLabel: null,
      projectKey: null,
      projectName: null,
      projectPath: null,
      matchBasis: 'unresolved',
      isExternalOrHistorical: true,
    };
  }
  return {
    party,
    displayName: session.label,
    sessionKey: session.sessionKey,
    sessionId: session.nativeSessionId || party.sessionId || session.sessionKey,
    sessionLabel: session.label,
    projectKey: session.projectKey,
    projectName: session.projectName,
    projectPath: session.cwd,
    matchBasis,
    isExternalOrHistorical: false,
  };
}

/**
 * Resolves evidenced session keys strictly via exact sessionKey or unique nativeSessionId.
 * Used by both model assembly and live SSE pulse detection.
 */
export function resolveEvidencedSessionKeysForMessage(
  raw: PeerMessageRecord,
  sessions: OfficeSessionItem[],
): string[] {
  const index = buildSessionLookupIndex(sessions);
  const keys = new Set<string>();
  const fromMatch = matchSessionStrictly(raw.from, index);
  if (fromMatch.session) keys.add(fromMatch.session.sessionKey);
  const toMatch = matchSessionStrictly(raw.to, index);
  if (toMatch.session) keys.add(toMatch.session.sessionKey);
  return [...keys];
}

function compareMessagesNewestFirst(a: EnrichedPeerMessage, b: EnrichedPeerMessage): number {
  if (a.raw.createdAt !== b.raw.createdAt) {
    return b.raw.createdAt - a.raw.createdAt;
  }
  return b.id.localeCompare(a.id);
}

function buildJoinedSessions(input: BuildOfficeWorkspaceInput): OfficeSessionItem[] {
  const dirByKey = new Map<string, TerminalDirectorySession>();
  for (const session of input.directorySessions) {
    const key = String(session.sessionKey || '').trim();
    if (!key || input.hiddenSessionKeys.has(key)) continue;
    dirByKey.set(key, session);
  }

  const interactiveByKey = new Map<string, WebTerminalTab>();
  for (const tab of input.interactiveTabs) {
    if (!tab.sessionKey || input.hiddenSessionKeys.has(tab.sessionKey)) continue;
    interactiveByKey.set(tab.sessionKey, tab);
  }

  const unavailableByKey = new Map<string, WebTerminalTab>();
  for (const tab of input.unavailableTabs) {
    if (!tab.sessionKey || input.hiddenSessionKeys.has(tab.sessionKey)) continue;
    unavailableByKey.set(tab.sessionKey, tab);
  }

  const allKeys = new Set<string>([
    ...dirByKey.keys(),
    ...interactiveByKey.keys(),
    ...unavailableByKey.keys(),
  ]);

  const draftItems: OfficeSessionItem[] = [];
  for (const sessionKey of allKeys) {
    const dir = dirByKey.get(sessionKey);
    const interactiveTab = interactiveByKey.get(sessionKey);
    const unavailableTab = unavailableByKey.get(sessionKey);

    let availability: SessionAvailability;
    let canAttachTerminal = false;
    let tab: WebTerminalTab | undefined;

    if (unavailableTab) {
      availability = 'unavailable';
      canAttachTerminal = false;
      tab = unavailableTab;
    } else if (interactiveTab) {
      availability = 'interactive';
      canAttachTerminal = true;
      tab = interactiveTab;
    } else if (dir?.status === 'exited') {
      availability = 'exited';
      canAttachTerminal = false;
    } else {
      availability = 'directory-only';
      canAttachTerminal = false;
    }

    const source: 'native' | 'web' = dir?.source || (sessionKey.startsWith('native:') ? 'native' : 'web');
    const kind: 'account-cli' | 'shell' = tab?.kind || (source === 'native' ? 'account-cli' : 'shell');
    // project-shell 没有可保的「任务」：已退出且不可交互的 shell 只会留下无法接入的幽灵工位。
    if (kind === 'shell' && availability === 'exited' && !interactiveTab) continue;
    const cwd = String(dir?.cwd ?? tab?.cwd ?? '').trim();
    const projectKey = normalizeProjectPath(cwd);
    const projectName = extractProjectDisplayName(projectKey);
    const provider = String(dir?.provider || tab?.harness || (kind === 'shell' ? 'shell' : '')).trim();
    const harness = String(tab?.harness || dir?.provider || '').trim() || undefined;
    const nativeSessionId = String(dir?.nativeSessionId || tab?.nativeSessionId || '').trim() || undefined;
    const label = String(tab?.label || dir?.label || sessionKey).trim() || sessionKey;
    const shortLabel = buildShortSessionLabel(label, projectName, kind);
    const previewKey = nativeSessionId && provider
      ? buildPreviewCacheKey(input.serverId, provider, nativeSessionId, cwd)
      : '';
    const cachedPreview = previewKey ? input.previewsByCacheKey.get(previewKey) : undefined;
    const previewModel = cachedPreview?.model?.trim() || undefined;
    const contentPreview = cachedPreview?.preview?.trim() || undefined;
    const model = previewModel || tab?.model;
    const recentPulse = input.recentPulseSessionKeys.has(sessionKey);

    draftItems.push({
      id: tab?.id || `web-terminal:${sessionKey}`,
      sessionKey,
      serverId: tab?.serverId || input.serverId,
      label,
      shortLabel,
      cwd,
      projectKey,
      projectName,
      kind,
      provider,
      harness,
      model,
      nativeSessionId,
      termId: dir?.termId,
      source,
      availability,
      canAttachTerminal,
      tab,
      persona: createInitialPersona(sessionKey, provider, kind, availability, 0),
      activity: createEmptyActivity(recentPulse),
      inboxCount: 0,
      sentCount: 0,
      pendingCount: 0,
      crossProjectCount: 0,
      contentPreview,
      previewModel,
    });
  }

  const availabilityRank: Record<SessionAvailability, number> = {
    interactive: 0,
    'directory-only': 1,
    unavailable: 2,
    exited: 3,
  };
  draftItems.sort((a, b) => {
    const rankDiff = availabilityRank[a.availability] - availabilityRank[b.availability];
    if (rankDiff !== 0) return rankDiff;
    const labelDiff = a.label.localeCompare(b.label);
    if (labelDiff !== 0) return labelDiff;
    return a.sessionKey.localeCompare(b.sessionKey);
  });

  const seatCountByProject = new Map<string, number>();
  return draftItems.map((item) => {
    const seatIndex = seatCountByProject.get(item.projectKey) || 0;
    seatCountByProject.set(item.projectKey, seatIndex + 1);
    return {
      ...item,
      persona: createInitialPersona(item.sessionKey, item.provider, item.kind, item.availability, seatIndex),
    };
  });
}

function attachPeerTelemetry(
  sessions: OfficeSessionItem[],
  enrichedMessages: EnrichedPeerMessage[],
  recentPulseSessionKeys: ReadonlySet<string>,
): OfficeSessionItem[] {
  const bySession = new Map<string, EnrichedPeerMessage[]>();
  for (const msg of enrichedMessages) {
    for (const key of msg.involvedSessionKeys) {
      const list = bySession.get(key);
      if (list) list.push(msg);
      else bySession.set(key, [msg]);
    }
  }

  return sessions.map((session) => {
    const related = bySession.get(session.sessionKey) || [];
    const recentPulse = recentPulseSessionKeys.has(session.sessionKey);
    if (related.length === 0) {
      return {
        ...session,
        activity: createEmptyActivity(recentPulse),
      };
    }

    let inboxCount = 0;
    let sentCount = 0;
    let pendingCount = 0;
    let crossProjectCount = 0;
    let unreadOrDeliveredCount = 0;
    let failedCount = 0;
    let lastMessageAt = 0;
    let activeIncoming = false;
    let activeOutgoing = false;

    for (const msg of related) {
      const isTo = msg.toResolved.sessionKey === session.sessionKey;
      const isFrom = msg.fromResolved.sessionKey === session.sessionKey;
      const activePending = isRecordActivelyPending(msg.raw);
      if (isTo) inboxCount += 1;
      if (isFrom) sentCount += 1;
      if (activePending) pendingCount += 1;
      if (msg.isCrossProject) crossProjectCount += 1;
      if (isTo && (activePending || msg.raw.state === 'delivered')) {
        unreadOrDeliveredCount += 1;
      }
      if (msg.raw.state === 'failed') failedCount += 1;
      if (msg.raw.createdAt > lastMessageAt) lastMessageAt = msg.raw.createdAt;

      const isActiveMessage = activePending || (isTo && msg.raw.state === 'delivered');
      if (isActiveMessage) {
        if (isTo) activeIncoming = true;
        if (isFrom) activeOutgoing = true;
      }
    }

    const latest = related[0];
    if (recentPulse && !activeIncoming && !activeOutgoing && latest) {
      if (latest.toResolved.sessionKey === session.sessionKey) activeIncoming = true;
      if (latest.fromResolved.sessionKey === session.sessionKey) activeOutgoing = true;
    }

    let kind: SessionActivityCue['kind'] = 'idle';
    if (activeIncoming && activeOutgoing) kind = 'both';
    else if (activeIncoming) kind = 'incoming';
    else if (activeOutgoing) kind = 'outgoing';

    const posture: EmployeeVisualPersona['posture'] = unreadOrDeliveredCount > 0 || pendingCount > 0
      ? 'reading'
      : session.availability === 'interactive'
        ? 'typing'
        : 'monitoring';

    return {
      ...session,
      inboxCount,
      sentCount,
      pendingCount,
      crossProjectCount,
      persona: {
        ...session.persona,
        posture,
      },
      activity: {
        kind,
        pendingCount,
        unreadOrDeliveredCount,
        failedCount,
        lastMessageAt,
        recentPulse,
        latestSnippet: latest ? latest.snippet : '',
      },
    };
  });
}

function buildProjectRooms(
  sessions: OfficeSessionItem[],
  enrichedMessages: EnrichedPeerMessage[],
): OfficeProjectRoom[] {
  const sessionsByProject = new Map<string, OfficeSessionItem[]>();
  for (const session of sessions) {
    const bucket = sessionsByProject.get(session.projectKey);
    if (bucket) bucket.push(session);
    else sessionsByProject.set(session.projectKey, [session]);
  }

  const messagesByProject = new Map<string, EnrichedPeerMessage[]>();
  for (const msg of enrichedMessages) {
    for (const projectKey of msg.involvedProjectKeys) {
      const bucket = messagesByProject.get(projectKey);
      if (bucket) bucket.push(msg);
      else messagesByProject.set(projectKey, [msg]);
    }
  }

  const rooms: OfficeProjectRoom[] = [];
  for (const [projectKey, roomSessions] of sessionsByProject.entries()) {
    const roomMessages = messagesByProject.get(projectKey) || [];
    let runningCount = 0;
    let unavailableCount = 0;
    let exitedCount = 0;
    let hasRecentPulse = false;

    for (const session of roomSessions) {
      if (session.availability === 'interactive' || session.availability === 'directory-only') {
        runningCount += 1;
      } else if (session.availability === 'unavailable') {
        unavailableCount += 1;
      } else if (session.availability === 'exited') {
        exitedCount += 1;
      }
      if (session.activity.recentPulse) {
        hasRecentPulse = true;
      }
    }

    let pendingMailCount = 0;
    let crossProjectMailCount = 0;
    let latestActivityAt = 0;
    for (const msg of roomMessages) {
      if (isRecordActivelyPending(msg.raw)) pendingMailCount += 1;
      if (msg.isCrossProject) crossProjectMailCount += 1;
      const msgAt = Math.max(msg.raw.createdAt, msg.raw.deliveredAt, msg.raw.readAt);
      if (msgAt > latestActivityAt) latestActivityAt = msgAt;
    }

    const isFallbackRoom = projectKey === NO_CWD_PROJECT_KEY;
    rooms.push({
      projectKey,
      projectName: extractProjectDisplayName(projectKey),
      projectPath: isFallbackRoom ? '' : projectKey,
      isFallbackRoom,
      sessions: roomSessions,
      runningCount,
      unavailableCount,
      exitedCount,
      roomMessages,
      pendingMailCount,
      crossProjectMailCount,
      latestActivityAt,
      hasRecentPulse,
    });
  }

  rooms.sort((a, b) => {
    if (a.isFallbackRoom !== b.isFallbackRoom) return a.isFallbackRoom ? 1 : -1;
    const aHasRunning = a.runningCount > 0;
    const bHasRunning = b.runningCount > 0;
    if (aHasRunning !== bHasRunning) return aHasRunning ? -1 : 1;
    const nameDiff = a.projectName.localeCompare(b.projectName);
    if (nameDiff !== 0) return nameDiff;
    return a.projectKey.localeCompare(b.projectKey);
  });

  return rooms;
}

function sessionMatchesFilters(
  session: OfficeSessionItem,
  normalizedQuery: string,
  providerFilter: string,
): boolean {
  if (providerFilter && providerFilter !== 'all') {
    if (session.provider !== providerFilter && session.harness !== providerFilter) {
      return false;
    }
  }
  if (!normalizedQuery) return true;
  const haystack = [
    session.label,
    session.shortLabel,
    session.cwd,
    session.projectName,
    session.provider,
    session.harness || '',
    session.model || '',
    session.nativeSessionId || '',
    session.sessionKey,
    session.contentPreview || '',
  ].join(' ').toLowerCase();
  return haystack.includes(normalizedQuery);
}

function filterProjectRooms(
  rooms: OfficeProjectRoom[],
  query: string,
  providerFilter: string,
): OfficeProjectRoom[] {
  const normalizedQuery = query.trim().toLowerCase();
  const hasFilter = Boolean(normalizedQuery) || (Boolean(providerFilter) && providerFilter !== 'all');
  if (!hasFilter) return rooms;

  const filtered: OfficeProjectRoom[] = [];
  for (const room of rooms) {
    const matchingSessions = room.sessions.filter((session) => (
      sessionMatchesFilters(session, normalizedQuery, providerFilter)
    ));
    if (matchingSessions.length === 0) continue;

    let runningCount = 0;
    let unavailableCount = 0;
    let exitedCount = 0;
    let hasRecentPulse = false;
    for (const session of matchingSessions) {
      if (session.availability === 'interactive' || session.availability === 'directory-only') {
        runningCount += 1;
      } else if (session.availability === 'unavailable') {
        unavailableCount += 1;
      } else if (session.availability === 'exited') {
        exitedCount += 1;
      }
      if (session.activity.recentPulse) hasRecentPulse = true;
    }

    filtered.push({
      ...room,
      sessions: matchingSessions,
      runningCount,
      unavailableCount,
      exitedCount,
      hasRecentPulse,
    });
  }
  return filtered;
}

export function buildOfficeWorkspaceModel(input: BuildOfficeWorkspaceInput): OfficeWorkspaceSnapshot {
  const baseSessions = buildJoinedSessions(input);
  const lookupIndex = buildSessionLookupIndex(baseSessions);
  const threadRoots = resolveThreadRoots(input.rawMessages);
  const supersededByMap = resolveSupersededByMap(input.rawMessages);

  const enrichedMessages: EnrichedPeerMessage[] = input.rawMessages.map((raw) => {
    const fromResolved = resolvePeerEndpoint(raw.from, lookupIndex);
    const toResolved = resolvePeerEndpoint(raw.to, lookupIndex);
    const fromReadable = buildReadablePartySummary(fromResolved);
    const toReadable = buildReadablePartySummary(toResolved);
    const presentation = buildReadableMailPresentation(raw);
    const normalizedBody = raw.body.replace(/\r\n/g, '\n').trim();
    const subjectLine = presentation.title;
    const snippet = presentation.summary || presentation.title;

    const hasUnresolvedParty = fromResolved.matchBasis === 'unresolved' || toResolved.matchBasis === 'unresolved';
    const isFullyUnassigned = fromResolved.matchBasis === 'unresolved' && toResolved.matchBasis === 'unresolved';
    const isCrossProject = Boolean(
      fromResolved.projectKey
      && toResolved.projectKey
      && fromResolved.projectKey !== toResolved.projectKey,
    );

    const projectKeySet = new Set<string>();
    if (fromResolved.projectKey) projectKeySet.add(fromResolved.projectKey);
    if (toResolved.projectKey) projectKeySet.add(toResolved.projectKey);

    const sessionKeySet = new Set<string>();
    if (fromResolved.sessionKey) sessionKeySet.add(fromResolved.sessionKey);
    if (toResolved.sessionKey) sessionKeySet.add(toResolved.sessionKey);

    return {
      raw,
      id: raw.id,
      shortId: raw.shortId,
      subjectLine,
      normalizedBody,
      snippet,
      fromResolved,
      toResolved,
      fromReadable,
      toReadable,
      presentation,
      supersededByIds: supersededByMap.get(raw.id) ?? [],
      isCrossProject,
      isFullyUnassigned,
      hasUnresolvedParty,
      threadRootId: threadRoots.get(raw.id) || raw.id,
      involvedProjectKeys: [...projectKeySet],
      involvedSessionKeys: [...sessionKeySet],
    };
  });

  enrichedMessages.sort(compareMessagesNewestFirst);

  const allSessions = attachPeerTelemetry(baseSessions, enrichedMessages, input.recentPulseSessionKeys);
  const rooms = buildProjectRooms(allSessions, enrichedMessages);
  const filteredRooms = filterProjectRooms(rooms, input.query, input.providerFilter);
  const unavailableSessions = allSessions.filter((session) => session.availability === 'unavailable');

  const providerSet = new Set<string>();
  for (const session of allSessions) {
    const provider = session.provider || session.harness || '';
    if (provider) providerSet.add(provider);
  }
  const providerOptions = [...providerSet].sort((a, b) => a.localeCompare(b));

  const unassignedMessages = enrichedMessages.filter((msg) => msg.hasUnresolvedParty);
  let fullyUnassignedCount = 0;
  for (const msg of unassignedMessages) {
    if (msg.isFullyUnassigned) fullyUnassignedCount += 1;
  }

  return {
    rooms,
    filteredRooms,
    allSessions,
    unavailableSessions,
    providerOptions,
    peerMessages: enrichedMessages,
    unassignedMessages,
    fullyUnassignedCount,
  };
}

function messageMatchesStateFilter(
  msg: EnrichedPeerMessage,
  normalizedState: string,
  nowMs: number,
): boolean {
  if (!normalizedState || normalizedState === 'all') return true;
  const lifecycle = evaluateMailLifecycle(msg, nowMs);
  switch (normalizedState) {
    case 'undelivered':
      return lifecycle.isUndelivered && !lifecycle.isAttention;
    case 'stale':
      return lifecycle.isStaleOrManual;
    case 'delivered':
      return lifecycle.kind === 'delivered' || lifecycle.kind === 'read';
    case 'attention':
      return lifecycle.isAttention;
    case 'pending':
      return lifecycle.isUndelivered && !lifecycle.isAttention;
    case 'read':
      return lifecycle.kind === 'read';
    case 'failed':
      return lifecycle.kind === 'failed';
    default:
      return msg.raw.state === normalizedState || msg.raw.notificationState === normalizedState;
  }
}

function messageMatchesReplyFilter(
  msg: EnrichedPeerMessage,
  replyFilter: MailboxReplyFilter,
  explicitThreadedRootIds: ReadonlySet<string>,
): boolean {
  switch (replyFilter) {
    case 'all':
      return true;
    case 'required':
      return msg.presentation.replyPolicyKind === 'required';
    case 'none':
      return msg.presentation.replyPolicyKind === 'none';
    case 'threaded':
      return (
        Boolean(msg.raw.replyTo || msg.raw.replyToShort)
        || explicitThreadedRootIds.has(msg.threadRootId)
      );
    case 'unspecified':
      return msg.presentation.replyPolicyKind === 'unknown';
  }
}

function messageMatchesMailboxFilters(
  msg: EnrichedPeerMessage,
  normalizedState: string,
  replyFilter: MailboxReplyFilter,
  normalizedQuery: string,
  explicitThreadedRootIds: ReadonlySet<string>,
  nowMs: number,
): boolean {
  if (!messageMatchesStateFilter(msg, normalizedState, nowMs)) {
    return false;
  }
  if (!messageMatchesReplyFilter(msg, replyFilter, explicitThreadedRootIds)) {
    return false;
  }
  if (!normalizedQuery) return true;
  const haystack = [
    msg.id,
    msg.shortId,
    msg.raw.replyTo,
    msg.raw.replyToShort,
    msg.raw.supersedes || '',
    msg.presentation.title,
    msg.presentation.summary,
    msg.presentation.purpose,
    msg.presentation.actionText,
    msg.presentation.replyPolicyLabel,
    msg.subjectLine,
    msg.normalizedBody,
    msg.raw.from.provider,
    msg.raw.from.name,
    msg.raw.from.address,
    msg.raw.from.sessionId,
    msg.fromResolved.displayName,
    msg.fromResolved.projectName || '',
    msg.fromReadable.shortName,
    msg.fromReadable.projectLabel,
    msg.raw.to.provider,
    msg.raw.to.name,
    msg.raw.to.address,
    msg.raw.to.sessionId,
    msg.toResolved.displayName,
    msg.toResolved.projectName || '',
    msg.toReadable.shortName,
    msg.toReadable.projectLabel,
    msg.raw.notificationState || '',
    msg.raw.waitingReason || '',
    msg.raw.error,
    msg.raw.lastAttemptError,
  ].join(' ').toLowerCase();
  return haystack.includes(normalizedQuery);
}

function collectExplicitThreadedRoots(messages: EnrichedPeerMessage[]): Set<string> {
  const countsByRoot = new Map<string, number>();
  const rootsWithReplyRef = new Set<string>();
  for (const msg of messages) {
    countsByRoot.set(msg.threadRootId, (countsByRoot.get(msg.threadRootId) || 0) + 1);
    if (msg.raw.replyTo || msg.raw.replyToShort) {
      rootsWithReplyRef.add(msg.threadRootId);
    }
  }
  const result = new Set<string>();
  for (const rootId of rootsWithReplyRef) {
    result.add(rootId);
  }
  for (const [rootId, count] of countsByRoot.entries()) {
    if (count > 1 && rootsWithReplyRef.has(rootId)) {
      result.add(rootId);
    }
  }
  return result;
}

function buildThreadGroups(messages: EnrichedPeerMessage[]): PeerThreadGroup[] {
  const byRoot = new Map<string, EnrichedPeerMessage[]>();
  const seenIds = new Set<string>();
  for (const msg of messages) {
    if (seenIds.has(msg.id)) continue;
    seenIds.add(msg.id);
    const group = byRoot.get(msg.threadRootId);
    if (group) group.push(msg);
    else byRoot.set(msg.threadRootId, [msg]);
  }

  const threads: PeerThreadGroup[] = [];
  for (const [threadId, group] of byRoot.entries()) {
    const ordered = group.slice().sort((a, b) => {
      if (a.raw.createdAt !== b.raw.createdAt) {
        return a.raw.createdAt - b.raw.createdAt;
      }
      return a.id.localeCompare(b.id);
    });
    const latestMessage = ordered[ordered.length - 1];
    const firstMessage = ordered[0];
    let latestAt = 0;
    let hasPending = false;
    let hasFailed = false;
    let isCrossProject = false;
    const threadProjects = new Set<string>();

    for (const item of ordered) {
      if (item.raw.createdAt > latestAt) latestAt = item.raw.createdAt;
      if (isRecordActivelyPending(item.raw)) hasPending = true;
      if (item.raw.state === 'failed') hasFailed = true;
      if (item.isCrossProject) isCrossProject = true;
      for (const pKey of item.involvedProjectKeys) {
        threadProjects.add(pKey);
      }
    }
    if (threadProjects.size > 1) isCrossProject = true;

    threads.push({
      threadId,
      subjectLine: firstMessage.presentation.title || firstMessage.subjectLine,
      messages: ordered,
      latestMessage,
      latestAt,
      messageCount: ordered.length,
      hasPending,
      hasFailed,
      isCrossProject,
    });
  }

  threads.sort((a, b) => {
    const aMulti = a.messageCount > 1 ? 1 : 0;
    const bMulti = b.messageCount > 1 ? 1 : 0;
    if (aMulti !== bMulti) return bMulti - aMulti;
    if (a.latestAt !== b.latestAt) return b.latestAt - a.latestAt;
    return b.threadId.localeCompare(a.threadId);
  });
  return threads;
}

export function buildSessionMailboxView(
  messages: EnrichedPeerMessage[],
  session: OfficeSessionItem | null,
  room: OfficeProjectRoom | null,
  scope: MailboxScope,
  folder: MailboxFolder,
  stateFilter: string,
  searchQuery: string,
  replyFilter: MailboxReplyFilter = 'all',
  nowMs: number = Date.now(),
): SessionMailboxViewResult {
  let inboxMsgs: EnrichedPeerMessage[] = [];
  let sentMsgs: EnrichedPeerMessage[] = [];
  let allMsgs: EnrichedPeerMessage[] = [];
  let threadPoolMsgs: EnrichedPeerMessage[] = [];

  if (scope === 'session') {
    if (session) {
      inboxMsgs = messages.filter((msg) => msg.toResolved.sessionKey === session.sessionKey);
      sentMsgs = messages.filter((msg) => msg.fromResolved.sessionKey === session.sessionKey);
      allMsgs = messages.filter(
        (msg) => msg.fromResolved.sessionKey === session.sessionKey || msg.toResolved.sessionKey === session.sessionKey,
      );
      const rootIds = new Set(allMsgs.map((msg) => msg.threadRootId));
      threadPoolMsgs = messages.filter((msg) => rootIds.has(msg.threadRootId));
    }
  } else if (scope === 'room') {
    if (room) {
      const roomKeys = new Set(room.sessions.map((item) => item.sessionKey));
      inboxMsgs = room.roomMessages.filter(
        (msg) => Boolean(msg.toResolved.sessionKey && roomKeys.has(msg.toResolved.sessionKey)),
      );
      sentMsgs = room.roomMessages.filter(
        (msg) => Boolean(msg.fromResolved.sessionKey && roomKeys.has(msg.fromResolved.sessionKey)),
      );
      allMsgs = room.roomMessages;
      const rootIds = new Set(allMsgs.map((msg) => msg.threadRootId));
      threadPoolMsgs = messages.filter((msg) => rootIds.has(msg.threadRootId));
    }
  } else if (scope === 'unassigned') {
    allMsgs = messages.filter((msg) => msg.hasUnresolvedParty);
    inboxMsgs = allMsgs.filter((msg) => msg.toResolved.matchBasis === 'unresolved');
    sentMsgs = allMsgs.filter((msg) => msg.fromResolved.matchBasis === 'unresolved');
    const rootIds = new Set(allMsgs.map((msg) => msg.threadRootId));
    threadPoolMsgs = messages.filter((msg) => rootIds.has(msg.threadRootId));
  } else {
    allMsgs = messages;
    inboxMsgs = session ? messages.filter((msg) => msg.toResolved.sessionKey === session.sessionKey) : messages;
    sentMsgs = session ? messages.filter((msg) => msg.fromResolved.sessionKey === session.sessionKey) : messages;
    threadPoolMsgs = messages;
  }

  let activeFolderMsgs: EnrichedPeerMessage[];
  switch (folder) {
    case 'inbox':
      activeFolderMsgs = inboxMsgs;
      break;
    case 'sent':
      activeFolderMsgs = sentMsgs;
      break;
    case 'threads':
      activeFolderMsgs = threadPoolMsgs;
      break;
    case 'all':
    default:
      activeFolderMsgs = allMsgs;
      break;
  }

  const explicitThreadedRootIds = collectExplicitThreadedRoots(messages);

  let undeliveredCount = 0;
  let staleCount = 0;
  let deliveredOrReadCount = 0;
  let attentionCount = 0;
  let replyRequiredCount = 0;
  let noReplyCount = 0;
  let threadedMsgCount = 0;
  let unspecifiedReplyCount = 0;

  for (const msg of activeFolderMsgs) {
    const lifecycle = evaluateMailLifecycle(msg, nowMs);
    if (lifecycle.isUndelivered && !lifecycle.isAttention) undeliveredCount += 1;
    if (lifecycle.isStaleOrManual) staleCount += 1;
    if (lifecycle.kind === 'delivered' || lifecycle.kind === 'read') deliveredOrReadCount += 1;
    if (lifecycle.isAttention) attentionCount += 1;
    if (msg.presentation.replyPolicyKind === 'required') replyRequiredCount += 1;
    if (msg.presentation.replyPolicyKind === 'none') noReplyCount += 1;
    if (msg.presentation.replyPolicyKind === 'unknown') unspecifiedReplyCount += 1;
    if (
      Boolean(msg.raw.replyTo || msg.raw.replyToShort)
      || explicitThreadedRootIds.has(msg.threadRootId)
    ) {
      threadedMsgCount += 1;
    }
  }

  const normalizedQuery = searchQuery.trim().toLowerCase();
  const normalizedState = (stateFilter || 'all').trim().toLowerCase();

  const filteredMessages = activeFolderMsgs
    .filter((msg) => (
      messageMatchesMailboxFilters(
        msg,
        normalizedState,
        replyFilter,
        normalizedQuery,
        explicitThreadedRootIds,
        nowMs,
      )
    ))
    .slice()
    .sort(compareMessagesNewestFirst);

  const allThreads = buildThreadGroups(threadPoolMsgs);
  const threads = normalizedState === 'all' && replyFilter === 'all' && !normalizedQuery
    ? allThreads
    : allThreads.filter((thread) => (
      thread.messages.some((msg) => (
        messageMatchesMailboxFilters(
          msg,
          normalizedState,
          replyFilter,
          normalizedQuery,
          explicitThreadedRootIds,
          nowMs,
        )
      ))
    ));

  return {
    filteredMessages,
    threads,
    inboxCount: inboxMsgs.length,
    sentCount: sentMsgs.length,
    allCount: allMsgs.length,
    threadCount: allThreads.length,
    undeliveredCount,
    staleCount,
    deliveredOrReadCount,
    attentionCount,
    replyRequiredCount,
    noReplyCount,
    threadedMsgCount,
    unspecifiedReplyCount,
  };
}
