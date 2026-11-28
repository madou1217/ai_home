import { useCallback, useSyncExternalStore } from 'react';
import type {
  OfficeComputerPreferences,
  OfficeMonitorTransform,
} from './office-computer-state';
import type {
  OfficeProjectRoom,
  OfficeSessionItem,
  SessionAvailability,
} from './session-office-types';

export type OfficeDesktopWallpaperId = OfficeComputerPreferences['wallpaper'];

export interface OfficeDesktopWallpaperOption {
  id: OfficeDesktopWallpaperId;
  label: string;
  subtitle: string;
  description: string;
  accentHex: string;
  suggestedAssetPath: string;
}

export const OFFICE_DESKTOP_WALLPAPERS: readonly OfficeDesktopWallpaperOption[] = Object.freeze([
  {
    id: 'aurora',
    label: '极光冷翠',
    subtitle: 'Aurora Cyan',
    description: '极夜深海山脊与流动青翠极光帷幕光影',
    accentHex: '#00e5ff',
    suggestedAssetPath: '/ui/office-assets/computer-v3/wallpaper-aurora.webp',
  },
  {
    id: 'sunset',
    label: '暮光琥珀',
    subtitle: 'Dusk Amber',
    description: '暖暮紫金天际、落日地平光晕与层叠暮色山脊',
    accentHex: '#f59e0b',
    suggestedAssetPath: '/ui/office-assets/computer-v3/wallpaper-sunset.webp',
  },
  {
    id: 'midnight',
    label: '深空午夜',
    subtitle: 'Midnight Indigo',
    description: '哑光深石墨与钴蓝雕塑感流线丝带及拉丝银微光边缘',
    accentHex: '#3b82f6',
    suggestedAssetPath: '/ui/office-assets/computer-v3/wallpaper-midnight.webp',
  },
]);

export const OFFICE_DESKTOP_WALLPAPER_MAP: Readonly<
  Record<OfficeDesktopWallpaperId, OfficeDesktopWallpaperOption>
> = Object.freeze({
  aurora: OFFICE_DESKTOP_WALLPAPERS[0],
  sunset: OFFICE_DESKTOP_WALLPAPERS[1],
  midnight: OFFICE_DESKTOP_WALLPAPERS[2],
});

export interface RgbSwatchOption {
  hex: string;
  label: string;
}

export const OFFICE_DESKTOP_RGB_SWATCHES: readonly RgbSwatchOption[] = Object.freeze([
  { hex: '#00e5ff', label: '冰川青' },
  { hex: '#10b981', label: '极光绿' },
  { hex: '#8b5cf6', label: '星云紫' },
  { hex: '#f59e0b', label: '琥珀金' },
  { hex: '#ec4899', label: '霓虹粉' },
  { hex: '#3b82f6', label: '深海蓝' },
]);

export function sanitizeRgbHexColor(value: string, fallback = '#00e5ff'): string {
  const trimmed = value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  if (/^#[0-9a-fA-F]{3}$/.test(trimmed)) {
    const [, r, g, b] = trimmed;
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  return fallback;
}

export type DesktopWallpaperAssetResolver = (
  wallpaperId: OfficeDesktopWallpaperId,
) => string | null | undefined;

interface VerifiedAssetEntry {
  url: string;
  status: 'loading' | 'ready' | 'error';
  generation: number;
  image: HTMLImageElement | null;
}

interface GlobalWallpaperWindow {
  __AIH_OFFICE_WALLPAPER_URLS__?: Partial<Record<OfficeDesktopWallpaperId, string>>;
}

export const DEFAULT_DESKTOP_WALLPAPER_ASSET_RESOLVER: DesktopWallpaperAssetResolver = (
  wallpaperId,
) => (OFFICE_DESKTOP_WALLPAPER_MAP[wallpaperId] ?? OFFICE_DESKTOP_WALLPAPERS[0]).suggestedAssetPath;

let customAssetResolver: DesktopWallpaperAssetResolver | null =
  DEFAULT_DESKTOP_WALLPAPER_ASSET_RESOLVER;
let assetGeneration = 1;
const verifiedAssetCache = new Map<string, VerifiedAssetEntry>();
const assetListeners = new Set<() => void>();

function notifyAssetListeners(): void {
  for (const listener of [...assetListeners]) {
    listener();
  }
}

function clearVerifiedAssetEntries(): void {
  assetGeneration += 1;
  for (const entry of verifiedAssetCache.values()) {
    if (entry.image) {
      entry.image.onload = null;
      entry.image.onerror = null;
      entry.image = null;
    }
  }
  verifiedAssetCache.clear();
}

/**
 * Registers an optional URL resolver for raster wallpaper files
 * (defaults to `/ui/office-assets/computer-v3/wallpaper-${id}.webp`).
 * Passing `null` forces pure CSS procedural gradient fallback.
 */
export function registerDesktopWallpaperAssetResolver(
  resolver: DesktopWallpaperAssetResolver | null,
): void {
  if (customAssetResolver === resolver) return;
  customAssetResolver = resolver;
  clearVerifiedAssetEntries();
  notifyAssetListeners();
}

function resolveCandidateAssetUrl(wallpaperId: OfficeDesktopWallpaperId): string | null {
  if (customAssetResolver) {
    const resolved = customAssetResolver(wallpaperId);
    if (typeof resolved === 'string' && resolved.trim()) {
      return resolved.trim();
    }
  }
  if (typeof window !== 'undefined') {
    const runtimeMap = (window as unknown as GlobalWallpaperWindow).__AIH_OFFICE_WALLPAPER_URLS__;
    const candidate = runtimeMap?.[wallpaperId];
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }
  return null;
}

function readVerifiedWallpaperAssetUrl(wallpaperId: OfficeDesktopWallpaperId): string | null {
  const candidateUrl = resolveCandidateAssetUrl(wallpaperId);
  if (!candidateUrl || typeof Image === 'undefined') {
    return null;
  }

  const cached = verifiedAssetCache.get(candidateUrl);
  if (cached) {
    return cached.status === 'ready' ? cached.url : null;
  }

  const gen = assetGeneration;
  const img = new Image();
  const entry: VerifiedAssetEntry = {
    url: candidateUrl,
    status: 'loading',
    generation: gen,
    image: img,
  };
  verifiedAssetCache.set(candidateUrl, entry);

  img.onload = () => {
    const valid = img.naturalWidth > 0 && img.naturalHeight > 0;
    img.onload = null;
    img.onerror = null;
    entry.image = null;
    if (entry.generation !== assetGeneration) return;
    if (valid) {
      entry.status = 'ready';
      notifyAssetListeners();
    } else {
      entry.status = 'error';
    }
  };
  img.onerror = () => {
    img.onload = null;
    img.onerror = null;
    entry.image = null;
    if (entry.generation !== assetGeneration) return;
    entry.status = 'error';
  };
  img.src = candidateUrl;

  return null;
}

function subscribeWallpaperAsset(listener: () => void): () => void {
  assetListeners.add(listener);
  return () => {
    assetListeners.delete(listener);
  };
}

export function useOptionalDesktopWallpaperAsset(
  wallpaperId: OfficeDesktopWallpaperId,
): string | null {
  const getSnapshot = useCallback(
    () => readVerifiedWallpaperAssetUrl(wallpaperId),
    [wallpaperId],
  );
  const getServerSnapshot = useCallback(() => null, []);
  return useSyncExternalStore(subscribeWallpaperAsset, getSnapshot, getServerSnapshot);
}

export interface ComputerConfigEntry {
  key: string;
  label: string;
  value: string;
  mono?: boolean;
}

export interface OfficeComputerConfigModel {
  realFactsTitle: string;
  realFactsBadge: string;
  realFactsCaption: string;
  realSessionFacts: ComputerConfigEntry[];
  virtualSpecsTitle: string;
  virtualSpecsBadge: string;
  virtualDisclaimer: string;
  scenePoseHint: string;
  virtualWorkstationSpecs: ComputerConfigEntry[];
}

function formatAvailabilityText(
  availability: SessionAvailability | undefined,
  canAttachEligibility: boolean | undefined,
  isPoweredOn: boolean,
  terminalReadyObserved: boolean,
): string {
  switch (availability) {
    case 'interactive': {
      if (!isPoweredOn) {
        return canAttachEligibility
          ? '目录可交互 (interactive · 具备附着入口，当前虚拟关机未附着；不等同于模型推理忙碌)'
          : '目录记录在线 (interactive · 不等同于模型推理忙碌)';
      }
      if (terminalReadyObserved) {
        return '在线可交互 (interactive · 当前终端视图已实测附着就绪；不等同于模型推理忙碌)';
      }
      return canAttachEligibility
        ? '具备原会话附着入口 / 可尝试接入 (interactive · 资格字段，不等同于已物理连接或模型忙碌)'
        : '目录记录在线 (interactive · 未分配受控附着入口)';
    }
    case 'directory-only':
      return '仅目录在线 (directory-only · 未建立受控交互入口)';
    case 'unavailable':
      return '原标识已保留 (unavailable · 暂未确认可接入)';
    case 'exited':
      return '进程已退出 (exited)';
    default:
      return '未选定活动会话';
  }
}

function formatWorkdirText(cwd: string | undefined): string {
  const trimmed = String(cwd ?? '').trim();
  if (!trimmed || trimmed === '__no_cwd__') {
    return '未指定工作目录（fallback）';
  }
  return trimmed;
}

function formatMonitorPose(label: string, transform: OfficeMonitorTransform): string {
  const deg = Math.round((transform.yaw * 180) / Math.PI);
  return `${label} X:${transform.x.toFixed(2)}m Y:${transform.y.toFixed(2)}m Z:${transform.z.toFixed(2)}m 偏航:${deg}°`;
}

export interface BuildOfficeComputerConfigInput {
  serverId: string;
  session: OfficeSessionItem | null;
  room: OfficeProjectRoom | null;
  preferences: OfficeComputerPreferences;
  loadedWallpaperAssetUrl: string | null;
  terminalReadyObserved?: boolean;
}

export function buildOfficeComputerConfigModel({
  serverId,
  session,
  room,
  preferences,
  loadedWallpaperAssetUrl,
  terminalReadyObserved = false,
}: BuildOfficeComputerConfigInput): OfficeComputerConfigModel {
  const wallpaperSpec = OFFICE_DESKTOP_WALLPAPER_MAP[preferences.wallpaper] ?? OFFICE_DESKTOP_WALLPAPERS[0];
  const activeSid = serverId.trim() || 'local';
  const sessionSid = String(session?.serverId || '').trim();
  const scopeMatches = !session || (Boolean(sessionSid) && sessionSid === activeSid);
  const resolvedServerDisplay = !session
    ? activeSid
    : scopeMatches
      ? sessionSid
      : `${sessionSid || '未知节点'}（与当前视图节点 ${activeSid} 作用域不一致，已阻断跨节点操作）`;

  const isPoweredOn = preferences.power === 'on';
  const roomName = room?.projectName || session?.projectName || '未分配房间';
  const workdir = formatWorkdirText(session?.cwd || room?.projectPath);

  const termHandleText = !session
    ? '未选定会话'
    : !isPoweredOn
      ? `当前虚拟关机未附着${session.tab?.id ? `（保留受控入口 ${session.tab.id}）` : ''}`
      : session.termId
        ? `目录记录 termId: ${session.termId}${session.tab?.id ? ` · 受控标签 ${session.tab.id}` : ''}`
        : session.tab?.id
          ? `受控附着入口: ${session.tab.id}（按原 sessionKey 尝试接入）`
          : '无受控附着入口';

  const realSessionFacts: ComputerConfigEntry[] = [
    {
      key: 'server-id',
      label: '所属服务器节点',
      value: resolvedServerDisplay,
      mono: scopeMatches,
    },
    {
      key: 'project-room',
      label: '所属项目房间',
      value: roomName,
    },
    {
      key: 'workdir',
      label: '工作目录路径',
      value: workdir,
      mono: true,
    },
    {
      key: 'session-key',
      label: '会话唯一标识',
      value: session?.sessionKey || '未选定会话',
      mono: true,
    },
    {
      key: 'native-id',
      label: '原生会话 ID',
      value: session?.nativeSessionId || '无（Web Shell 或未分配原生 ID）',
      mono: true,
    },
    {
      key: 'term-handle',
      label: '终端附着入口',
      value: termHandleText,
      mono: Boolean(session && isPoweredOn && (session.termId || session.tab?.id)),
    },
    {
      key: 'provider-channel',
      label: '运行来源与通道',
      value: session
        ? [
            session.provider || 'shell',
            session.source === 'web' ? 'Web 终端' : '原生 CLI',
            session.harness && session.harness !== session.provider ? session.harness : '',
          ].filter(Boolean).join(' · ')
        : '未选定',
    },
    {
      key: 'model',
      label: '上报模型标识',
      value: session?.previewModel || session?.model || '无模型字段（标准 Shell 或未上报）',
      mono: Boolean(session?.previewModel || session?.model),
    },
    {
      key: 'availability',
      label: '目录与附着资格',
      value: formatAvailabilityText(
        session?.availability,
        session?.canAttachTerminal,
        isPoweredOn,
        Boolean(scopeMatches && terminalReadyObserved),
      ),
    },
    {
      key: 'session-runtime',
      label: '运行会话',
      value: session
        ? `${session.provider || session.harness || '—'} · ${session.model || '默认模型'} · ${session.availability}`
        : (room ? `${room.sessions.length} 个工位 · ${room.runningCount} 运行` : '未选择工位'),
    },
  ];

  const poseSummary = preferences.dualMonitor
    ? `${formatMonitorPose('主屏', preferences.monitors[0])} ｜ ${formatMonitorPose('副屏', preferences.monitors[1])}`
    : formatMonitorPose('主屏', preferences.monitors[0]);

  const virtualWorkstationSpecs: ComputerConfigEntry[] = [
    {
      key: 'virtual-power',
      label: '虚拟主机电源',
      value: isPoweredOn
        ? '开机点亮（前端桌面与屏幕纹理开启；终端按原标识独立附着）'
        : '虚拟关机（屏幕待机熄灭 · 前端附着已断开，保留已存会话标识）',
    },
    {
      key: 'display-rig',
      label: '显示器配置',
      value: preferences.dualMonitor
        ? '双显示器扩展工作台（主屏 Display 01 + 副屏 Display 02 · 双臂支架）'
        : '单显示器标准工作台（主屏 Display 01 · 单臂人体工学支架）',
    },
    {
      key: 'scene-pose',
      label: '3D 屏幕空间位姿',
      value: poseSummary,
      mono: true,
    },
    {
      key: 'wallpaper',
      label: '桌面与 3D 屏幕壁纸',
      value: `${wallpaperSpec.label} (${wallpaperSpec.subtitle}) · ${
        loadedWallpaperAssetUrl
          ? `实景 WebP 资源 (原生 1376×768 · ${loadedWallpaperAssetUrl})`
          : 'CSS 光影渐变兜底（静态资源未加载时自动回退）'
      }`,
    },
    {
      key: 'chassis-rgb',
      label: '侧透机箱灯效',
      value: preferences.rgbEnabled
        ? `开启 · 同步色值 ${preferences.rgbColor.toUpperCase()}`
        : '关闭（低干扰无光模式）',
      mono: preferences.rgbEnabled,
    },
    {
      key: 'modeled-parts',
      label: '3D 虚拟主机组件',
      value: '侧透玻璃机箱 · ATX 主板 / 双风扇显卡模组 / 一体式水冷头与风扇 / 四槽灯条 / 独立电源仓 / 机械键鼠（纯三维场景外观模型）',
    },
  ];

  return {
    realFactsTitle: '当前会话真实连接事实',
    realFactsBadge: 'REAL // 实测会话字段',
    realFactsCaption: '仅展示当前服务器目录、终端管理器与协作邮箱已确认的真实字段，零虚构实时负载；原生与已存 Web 会话均不承诺跨后端或操作系统重启后的绝对恢复。',
    realSessionFacts,
    virtualSpecsTitle: '3D 虚拟工位建模规格',
    virtualSpecsBadge: 'VIRTUAL // 虚拟建模展示',
    virtualDisclaimer: '以下为三维工位外观模型与桌面个性化参数，绝非浏览器探测的宿主机真实 CPU / GPU / 内存硬件规格。',
    scenePoseHint: '屏幕空间位置 (X/Y/Z) 与偏航角调节位于 3D 办公室房间场景，可返回房间直接拖拽或微调显示器。',
    virtualWorkstationSpecs,
  };
}
