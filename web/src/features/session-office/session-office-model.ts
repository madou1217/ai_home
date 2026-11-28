import type { TerminalDirectorySession } from '@/services/api';
import type { WebTerminalTab } from '@/features/web-terminal/web-terminal-context';
import type {
  EmployeeVisualPersona,
  OfficeProjectRoom,
  OfficeSessionItem,
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
  previewsByCacheKey: ReadonlyMap<string, SessionPreviewCacheEntry>;
  query: string;
  providerFilter: string;
}

export interface OfficeWorkspaceSnapshot {
  rooms: OfficeProjectRoom[];
  filteredRooms: OfficeProjectRoom[];
  allSessions: OfficeSessionItem[];
  providerOptions: string[];
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

    if (interactiveTab) {
      availability = 'interactive';
      canAttachTerminal = true;
      tab = interactiveTab;
    } else if (dir?.status === 'exited') {
      availability = 'exited';
      canAttachTerminal = false;
    } else if (dir) {
      availability = 'directory-only';
      canAttachTerminal = false;
    } else if (unavailableTab) {
      // Saved native tab that the terminal directory cannot currently verify.
      // Keep the employee visible in the office; the separate "unavailable" list is gone.
      availability = 'unavailable';
      canAttachTerminal = false;
      tab = unavailableTab;
    } else {
      continue;
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

function buildProjectRooms(sessions: OfficeSessionItem[]): OfficeProjectRoom[] {
  const sessionsByProject = new Map<string, OfficeSessionItem[]>();
  for (const session of sessions) {
    const bucket = sessionsByProject.get(session.projectKey);
    if (bucket) bucket.push(session);
    else sessionsByProject.set(session.projectKey, [session]);
  }

  const rooms: OfficeProjectRoom[] = [];
  for (const [projectKey, roomSessions] of sessionsByProject.entries()) {
    let runningCount = 0;
    let exitedCount = 0;
    for (const session of roomSessions) {
      if (
        session.availability === 'interactive'
        || session.availability === 'directory-only'
        || session.availability === 'unavailable'
      ) {
        runningCount += 1;
      } else if (session.availability === 'exited') {
        exitedCount += 1;
      }
    }

    const isFallbackRoom = projectKey === NO_CWD_PROJECT_KEY;
    rooms.push({
      projectKey,
      projectName: extractProjectDisplayName(projectKey),
      projectPath: isFallbackRoom ? '' : projectKey,
      isFallbackRoom,
      sessions: roomSessions,
      runningCount,
      exitedCount,
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
    let exitedCount = 0;
    for (const session of matchingSessions) {
      if (
        session.availability === 'interactive'
        || session.availability === 'directory-only'
        || session.availability === 'unavailable'
      ) {
        runningCount += 1;
      } else if (session.availability === 'exited') {
        exitedCount += 1;
      }
    }

    filtered.push({
      ...room,
      sessions: matchingSessions,
      runningCount,
      exitedCount,
    });
  }
  return filtered;
}

export function buildOfficeWorkspaceModel(input: BuildOfficeWorkspaceInput): OfficeWorkspaceSnapshot {
  const allSessions = buildJoinedSessions(input);
  const rooms = buildProjectRooms(allSessions);
  const filteredRooms = filterProjectRooms(rooms, input.query, input.providerFilter);
  const providerSet = new Set<string>();
  for (const session of allSessions) {
    const provider = session.provider || session.harness || '';
    if (provider) providerSet.add(provider);
  }
  const providerOptions = [...providerSet].sort((a, b) => a.localeCompare(b));

  return {
    rooms,
    filteredRooms,
    allSessions,
    providerOptions,
  };
}