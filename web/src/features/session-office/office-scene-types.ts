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
  /** Minecraft 体素主题扩展字段（可选，向后兼容） */
  skyHex?: string;
  cloudHex?: string;
  sunMoonHex?: string;
  lanternGlowHex?: string;
  grassTintHex?: string;
  waterHex?: string;
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

// Minecraft 夜晚配色：深蓝夜空、月亮、暖色灯笼与室内红石灯、清晰高对比屏幕
const DARK_PALETTE: OfficeScenePalette = {
  mode: 'dark',
  backgroundHex: '#101d3b',
  fogHex: '#101d3b',
  floorBaseHex: '#b28651',
  floorGridHex: '#8d673b',
  floorAisleHex: '#25608a',
  wallPrimaryHex: '#7d828c',
  wallPanelHex: '#636873',
  wallTrimHex: '#6c5032',
  windowFrameHex: '#684c2f',
  windowGlassHex: '#94d6f8',
  windowSkyTopHex: '#0b142c',
  windowSkyBottomHex: '#1b315e',
  deskTopHex: '#ba8e57',
  deskEdgeHex: '#785432',
  deskLegHex: '#68492c',
  deskMatHex: '#1c2636',
  chairFabricHex: '#2c6e8f',
  chairMetalHex: '#606875',
  monitorShellHex: '#343b46',
  screenBgHex: '#0b111e',
  screenCardHex: '#121c30',
  screenBorderHex: '#35547a',
  screenTextHex: '#f0f7ff',
  screenMutedHex: '#9bb5cf',
  accentHex: '#38e8ff',
  successHex: '#3be86c',
  warningHex: '#ffbe2e',
  dangerHex: '#ff4769',
  violetHex: '#c084fc',
  skyHex: '#101d3b',
  cloudHex: '#4f6594',
  sunMoonHex: '#eaf1ff',
  lanternGlowHex: '#ffae47',
  grassTintHex: '#5ea834',
  waterHex: '#2b73cf',
};

// Minecraft 白天配色：晴朗浅蓝天空、金黄太阳、明亮草地与橡木地板
const LIGHT_PALETTE: OfficeScenePalette = {
  mode: 'light',
  backgroundHex: '#7cbaff',
  fogHex: '#9ad0ff',
  floorBaseHex: '#c89b60',
  floorGridHex: '#9e7542',
  floorAisleHex: '#2f82a8',
  wallPrimaryHex: '#9ba1ab',
  wallPanelHex: '#848a94',
  wallTrimHex: '#7d5b38',
  windowFrameHex: '#765535',
  windowGlassHex: '#cef0ff',
  windowSkyTopHex: '#6cb4ff',
  windowSkyBottomHex: '#bce2ff',
  deskTopHex: '#c89c62',
  deskEdgeHex: '#875f38',
  deskLegHex: '#74512f',
  deskMatHex: '#263345',
  chairFabricHex: '#2d7fa3',
  chairMetalHex: '#7c8594',
  monitorShellHex: '#3d4552',
  screenBgHex: '#0d1423',
  screenCardHex: '#142038',
  screenBorderHex: '#3b618c',
  screenTextHex: '#f2f9ff',
  screenMutedHex: '#a3bdd6',
  accentHex: '#19d6f2',
  successHex: '#2ad65f',
  warningHex: '#f59e0b',
  dangerHex: '#f43f5e',
  violetHex: '#a855f7',
  skyHex: '#7cbaff',
  cloudHex: '#ffffff',
  sunMoonHex: '#ffe64d',
  lanternGlowHex: '#ffc45e',
  grassTintHex: '#6ec43b',
  waterHex: '#3490f0',
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
