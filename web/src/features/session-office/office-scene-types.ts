import type {
  DesktopOriginRect,
  OfficeCameraPreset,
  OfficeSessionItem,
} from './session-office-types';
import type {
  OfficeComputerPreferences,
  OfficeMonitorTransform,
} from './office-computer-state';

export type OfficeSceneThemeMode = 'dark' | 'light';

export type OfficeHitKind = 'station' | 'monitor' | 'mail-tray' | 'room-mailbox';

export type OfficeMonitorIndex = 0 | 1;

export type OfficeMonitorDragMode = 'xz' | 'y' | 'yaw';

export interface OfficeHitTarget {
  kind: OfficeHitKind;
  sessionKey?: string;
  monitorIndex?: OfficeMonitorIndex;
}

export interface OfficeHoverInfo {
  kind: OfficeHitKind;
  sessionKey?: string;
  monitorIndex?: OfficeMonitorIndex;
  label: string;
  hint: string;
  clientX: number;
  clientY: number;
}

export interface OfficeScenePalette {
  mode: OfficeSceneThemeMode;
  backgroundHex: string;
  fogHex: string;
  floorBaseHex: string;
  floorGridHex: string;
  floorAisleHex: string;
  wallPrimaryHex: string;
  wallPanelHex: string;
  wallTrimHex: string;
  windowFrameHex: string;
  windowGlassHex: string;
  windowSkyTopHex: string;
  windowSkyBottomHex: string;
  deskTopHex: string;
  deskEdgeHex: string;
  deskLegHex: string;
  deskMatHex: string;
  chairFabricHex: string;
  chairMetalHex: string;
  monitorShellHex: string;
  screenBgHex: string;
  screenCardHex: string;
  screenBorderHex: string;
  screenTextHex: string;
  screenMutedHex: string;
  accentHex: string;
  successHex: string;
  warningHex: string;
  dangerHex: string;
  violetHex: string;
}

export interface OfficeSceneSyncState {
  serverId: string;
  roomKey: string;
  roomName: string;
  projectPath: string;
  isFallbackRoom: boolean;
  runningCount: number;
  totalSessionCount: number;
  pendingMailCount: number;
  crossProjectMailCount: number;
  roomMessageCount: number;
  hasRecentPulse: boolean;
  sessions: OfficeSessionItem[];
  selectedSessionKey: string | null;
  computerPreferences: Readonly<Record<string, OfficeComputerPreferences>>;
  cameraPreset: OfficeCameraPreset;
  theme: OfficeSceneThemeMode;
  reducedMotion: boolean;
}

export interface OfficeSceneCallbacks {
  onSelectStation: (sessionKey: string) => void;
  onOpenMonitor: (sessionKey: string, originRect?: DesktopOriginRect) => void;
  onOpenSessionMail: (sessionKey: string, originRect?: DesktopOriginRect) => void;
  onOpenRoomMailbox: () => void;
  onHoverTarget: (info: OfficeHoverInfo | null) => void;
  onActiveEditMonitorChange?: (monitorIndex: OfficeMonitorIndex) => void;
  onPreviewMonitorTransform?: (
    serverId: string,
    sessionKey: string,
    monitorIndex: OfficeMonitorIndex,
    transform: OfficeMonitorTransform
  ) => void;
  onCommitMonitorTransform?: (
    serverId: string,
    sessionKey: string,
    monitorIndex: OfficeMonitorIndex,
    transform: OfficeMonitorTransform
  ) => void;
  onCancelMonitorTransform?: (
    serverId: string,
    sessionKey: string,
    monitorIndex: OfficeMonitorIndex
  ) => void;
  onContextLostChange?: (lost: boolean) => void;
  onInitError?: (message: string) => void;
}

export interface BayCoordinate {
  x: number;
  z: number;
}

export interface BayGridMetrics {
  cols: number;
  rows: number;
  spacingX: number;
  spacingZ: number;
  roomWidth: number;
  roomDepth: number;
  bayPositions: BayCoordinate[];
}

const DARK_PALETTE: OfficeScenePalette = {
  mode: 'dark',
  backgroundHex: '#060b14',
  fogHex: '#060b14',
  floorBaseHex: '#0c1626',
  floorGridHex: '#152c47',
  floorAisleHex: '#122238',
  wallPrimaryHex: '#0e192b',
  wallPanelHex: '#132238',
  wallTrimHex: '#203957',
  windowFrameHex: '#1c2f47',
  windowGlassHex: '#4697c8',
  windowSkyTopHex: '#0d223c',
  windowSkyBottomHex: '#173e66',
  deskTopHex: '#18273b',
  deskEdgeHex: '#253c59',
  deskLegHex: '#28384d',
  deskMatHex: '#0b121e',
  chairFabricHex: '#1d2b40',
  chairMetalHex: '#354963',
  monitorShellHex: '#152132',
  screenBgHex: '#060d17',
  screenCardHex: '#0b1627',
  screenBorderHex: '#1c3554',
  screenTextHex: '#e6f4fc',
  screenMutedHex: '#84a2bc',
  accentHex: '#00e5ff',
  successHex: '#12eb74',
  warningHex: '#ffaa1d',
  dangerHex: '#ff2b6e',
  violetHex: '#a855f7',
};

const LIGHT_PALETTE: OfficeScenePalette = {
  mode: 'light',
  backgroundHex: '#dce6f0',
  fogHex: '#dce6f0',
  floorBaseHex: '#cfdbe6',
  floorGridHex: '#b3c4d4',
  floorAisleHex: '#c0cfde',
  wallPrimaryHex: '#e7eef5',
  wallPanelHex: '#dbe5ef',
  wallTrimHex: '#b8cadb',
  windowFrameHex: '#6f859b',
  windowGlassHex: '#7cc2ea',
  windowSkyTopHex: '#9ed2f2',
  windowSkyBottomHex: '#d9eefb',
  deskTopHex: '#f1f5f9',
  deskEdgeHex: '#c6d4e2',
  deskLegHex: '#64798e',
  deskMatHex: '#1e2c3e',
  chairFabricHex: '#31465e',
  chairMetalHex: '#73879c',
  monitorShellHex: '#263547',
  screenBgHex: '#0b1422',
  screenCardHex: '#101d30',
  screenBorderHex: '#264366',
  screenTextHex: '#edf6fc',
  screenMutedHex: '#94b0c9',
  accentHex: '#008da8',
  successHex: '#00a357',
  warningHex: '#c97800',
  dangerHex: '#d80049',
  violetHex: '#7c3aed',
};

export function getOfficeScenePalette(mode: OfficeSceneThemeMode): OfficeScenePalette {
  return mode === 'light' ? LIGHT_PALETTE : DARK_PALETTE;
}

export function computeBayGridMetrics(sessionCount: number): BayGridMetrics {
  const count = Math.max(1, sessionCount);
  const cols = count === 1 ? 1 : count <= 4 ? 2 : count <= 6 ? 3 : 4;
  const rows = Math.ceil(count / cols);

  const spacingX = cols <= 2 ? 3.2 : 2.95;
  const spacingZ = rows <= 1 ? 2.75 : 2.65;

  const contentWidth = (cols - 1) * spacingX + 2.6;
  const contentDepth = (rows - 1) * spacingZ + 2.4;

  const roomWidth = Math.max(7.2, contentWidth + 2.6);
  const roomDepth = Math.max(5.8, contentDepth + 2.8);

  const bayPositions: BayCoordinate[] = [];
  for (let i = 0; i < sessionCount; i += 1) {
    const row = Math.floor(i / cols);
    const col = i % cols;
    const rowCount = row === rows - 1 ? sessionCount - row * cols : cols;
    const rowOffsetX = ((rowCount - 1) * spacingX) / 2;
    const totalOffsetZ = ((rows - 1) * spacingZ) / 2;
    const x = col * spacingX - rowOffsetX;
    const z = row * spacingZ - totalOffsetZ + 0.35;
    bayPositions.push({ x, z });
  }

  return {
    cols,
    rows,
    spacingX,
    spacingZ,
    roomWidth,
    roomDepth,
    bayPositions,
  };
}
