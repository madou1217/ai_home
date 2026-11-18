import type { WebTerminalTab } from '@/features/web-terminal/web-terminal-context';

export type PeerDeliveryState = 'pending' | 'delivered' | 'read' | 'failed' | (string & {});

export interface PeerParty {
  channel: string;
  provider: string;
  name: string;
  address: string;
  sessionId: string;
}

export interface PeerMessageRecord {
  id: string;
  shortId: string;
  from: PeerParty;
  to: PeerParty;
  replyTo: string;
  replyToShort: string;
  body: string;
  state: PeerDeliveryState;
  createdAt: number;
  deliveredAt: number;
  readAt: number;
  nextAttemptAt: number;
  attemptCount: number;
  error: string;
  lastAttemptError: string;
  receiptError?: string;
}

export interface PeerCounts {
  total: number;
  pending: number;
  delivered: number;
  read: number;
  failed: number;
}

export type SessionAvailability = 'interactive' | 'directory-only' | 'unavailable' | 'exited';

export interface EmployeeVisualPersona {
  avatarTone: string;
  visorStyle: 'visor' | 'glasses' | 'headset';
  posture: 'typing' | 'monitoring' | 'reading';
  deskAccent: string;
  badgeCode: string;
  seatIndex: number;
}

export interface SessionActivityCue {
  kind: 'idle' | 'incoming' | 'outgoing' | 'both';
  pendingCount: number;
  unreadOrDeliveredCount: number;
  failedCount: number;
  lastMessageAt: number;
  recentPulse: boolean;
  latestSnippet: string;
}

export interface OfficeSessionItem {
  id: string;
  sessionKey: string;
  serverId: string;
  label: string;
  shortLabel: string;
  cwd: string;
  projectKey: string;
  projectName: string;
  kind: 'account-cli' | 'shell';
  provider: string;
  harness?: string;
  model?: string;
  nativeSessionId?: string;
  termId?: string;
  source: 'native' | 'web';
  availability: SessionAvailability;
  canAttachTerminal: boolean;
  tab?: WebTerminalTab;
  persona: EmployeeVisualPersona;
  activity: SessionActivityCue;
  inboxCount: number;
  sentCount: number;
  pendingCount: number;
  crossProjectCount: number;
  contentPreview?: string;
  previewModel?: string;
}

export interface ResolvedPeerEndpoint {
  party: PeerParty;
  displayName: string;
  sessionKey: string | null;
  sessionId: string | null;
  sessionLabel: string | null;
  projectKey: string | null;
  projectName: string | null;
  projectPath: string | null;
  matchBasis: 'nativeSessionId' | 'sessionKey' | 'scopedName' | 'unresolved';
  isExternalOrHistorical: boolean;
}

export interface EnrichedPeerMessage {
  raw: PeerMessageRecord;
  id: string;
  shortId: string;
  subjectLine: string;
  normalizedBody: string;
  snippet: string;
  fromResolved: ResolvedPeerEndpoint;
  toResolved: ResolvedPeerEndpoint;
  isCrossProject: boolean;
  isFullyUnassigned: boolean;
  hasUnresolvedParty: boolean;
  threadRootId: string;
  involvedProjectKeys: string[];
  involvedSessionKeys: string[];
}

export interface PeerThreadGroup {
  threadId: string;
  subjectLine: string;
  messages: EnrichedPeerMessage[];
  latestMessage: EnrichedPeerMessage;
  latestAt: number;
  messageCount: number;
  hasPending: boolean;
  hasFailed: boolean;
  isCrossProject: boolean;
}

export interface OfficeProjectRoom {
  projectKey: string;
  projectName: string;
  projectPath: string;
  isFallbackRoom: boolean;
  sessions: OfficeSessionItem[];
  runningCount: number;
  unavailableCount: number;
  exitedCount: number;
  roomMessages: EnrichedPeerMessage[];
  pendingMailCount: number;
  crossProjectMailCount: number;
  latestActivityAt: number;
  hasRecentPulse: boolean;
}

export type MailboxScope = 'session' | 'room' | 'unassigned' | 'all';
export type MailboxFolder = 'inbox' | 'sent' | 'all' | 'threads';
export type OfficeCameraPreset = 'isometric' | 'corridor' | 'overview';
export type DesktopWindowLayout = 'terminal-focus' | 'mail-focus' | 'split';

export interface DesktopOriginRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface SessionOfficeDataState {
  serverId: string;
  rooms: OfficeProjectRoom[];
  filteredRooms: OfficeProjectRoom[];
  allSessions: OfficeSessionItem[];
  unavailableSessions: OfficeSessionItem[];
  hiddenCount: number;
  providerOptions: string[];
  query: string;
  setQuery: (value: string) => void;
  providerFilter: string;
  setProviderFilter: (value: string) => void;
  directoryLoading: boolean;
  directoryError: string;
  peerMessages: EnrichedPeerMessage[];
  unassignedMessages: EnrichedPeerMessage[];
  fullyUnassignedCount: number;
  peerCounts: PeerCounts;
  peerLoading: boolean;
  peerError: string;
  recentPulseSessionKeys: ReadonlySet<string>;
  refreshAll: () => Promise<void>;
  refreshDirectory: () => Promise<void>;
  refreshPeerMessages: () => Promise<void>;
  openNewProjectTerminal: (cwd?: string) => Promise<void>;
  hideSession: (sessionId: string) => void;
  restoreHiddenSessions: () => void;
  copySessionIdentity: (session: Pick<OfficeSessionItem, 'label' | 'sessionKey' | 'nativeSessionId'>) => Promise<void>;
  activateManagerSession: (sessionId: string) => void;
}
