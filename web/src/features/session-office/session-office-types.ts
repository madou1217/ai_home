import type { WebTerminalTab } from '@/features/web-terminal/web-terminal-context';

export type SessionAvailability = 'interactive' | 'directory-only' | 'unavailable' | 'exited';

export interface EmployeeVisualPersona {
  avatarTone: string;
  visorStyle: 'visor' | 'glasses' | 'headset';
  posture: 'typing' | 'monitoring' | 'reading';
  deskAccent: string;
  badgeCode: string;
  seatIndex: number;
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
  contentPreview?: string;
  previewModel?: string;
}

export interface OfficeProjectRoom {
  projectKey: string;
  projectName: string;
  projectPath: string;
  isFallbackRoom: boolean;
  sessions: OfficeSessionItem[];
  runningCount: number;
  exitedCount: number;
}

export type OfficeCameraPreset = 'isometric' | 'corridor' | 'overview';
export type DesktopWindowLayout = 'terminal-focus' | 'split';

export interface DesktopOriginRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface TerminateSessionResult {
  ok: boolean;
  alreadyGone?: boolean;
  error?: string;
}

export interface OfficeSceneTerminationHookProps {
  onTerminateSession?: (session: OfficeSessionItem) => void | Promise<void>;
  terminatingSessionKey?: string;
}

export interface SessionOfficeDataState {
  serverId: string;
  rooms: OfficeProjectRoom[];
  filteredRooms: OfficeProjectRoom[];
  allSessions: OfficeSessionItem[];
  hiddenCount: number;
  providerOptions: string[];
  query: string;
  setQuery: (value: string) => void;
  providerFilter: string;
  setProviderFilter: (value: string) => void;
  directoryLoading: boolean;
  directoryError: string;
  terminatingSessionKey: string | null;
  isSessionTerminating: (sessionKey: string) => boolean;
  refreshAll: () => Promise<void>;
  refreshDirectory: () => Promise<void>;
  openNewProjectTerminal: (cwd?: string) => Promise<void>;
  terminateWebSession: (
    session: Pick<
      OfficeSessionItem,
      'id' | 'serverId' | 'sessionKey' | 'termId' | 'source' | 'label' | 'cwd' | 'availability'
    >,
  ) => Promise<TerminateSessionResult>;
  hideSession: (sessionId: string) => void;
  restoreHiddenSessions: () => void;
  copySessionIdentity: (
    session: Pick<OfficeSessionItem, 'label' | 'sessionKey' | 'nativeSessionId'>,
  ) => Promise<void>;
  activateManagerSession: (sessionId: string) => void;
}