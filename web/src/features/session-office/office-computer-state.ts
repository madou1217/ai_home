export type OfficeComputerPowerState = 'on' | 'off';

export type OfficeWallpaperId = 'aurora' | 'sunset' | 'midnight';

export interface OfficeMonitorTransform {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

export interface OfficeComputerPreferences {
  power: OfficeComputerPowerState;
  wallpaper: OfficeWallpaperId;
  rgbEnabled: boolean;
  rgbColor: string;
  /** Per-station monitor pose; each station stores its own transform. */
  monitor: OfficeMonitorTransform;
}

export interface OfficeWallpaperMetadata {
  id: OfficeWallpaperId;
  label: string;
  subtitle: string;
  accentHex: string;
  suggestedAssetPath: string;
}

export const OFFICE_WALLPAPER_IDS: readonly OfficeWallpaperId[] = Object.freeze([
  'aurora',
  'sunset',
  'midnight',
]);

export const OFFICE_WALLPAPER_META: Readonly<Record<OfficeWallpaperId, OfficeWallpaperMetadata>> = Object.freeze({
  aurora: Object.freeze({
    id: 'aurora',
    label: '极光冷翠',
    subtitle: 'Aurora Cyan',
    accentHex: '#00e5ff',
    suggestedAssetPath: '/ui/office-assets/computer-v3/wallpaper-aurora.webp',
  }),
  sunset: Object.freeze({
    id: 'sunset',
    label: '暮光琥珀',
    subtitle: 'Dusk Amber',
    accentHex: '#f59e0b',
    suggestedAssetPath: '/ui/office-assets/computer-v3/wallpaper-sunset.webp',
  }),
  midnight: Object.freeze({
    id: 'midnight',
    label: '深空午夜',
    subtitle: 'Midnight Indigo',
    accentHex: '#818cf8',
    suggestedAssetPath: '/ui/office-assets/computer-v3/wallpaper-midnight.webp',
  }),
});

export const OFFICE_RGB_PRESET_COLORS: readonly string[] = Object.freeze([
  '#00e5ff',
  '#10b981',
  '#8b5cf6',
  '#f59e0b',
  '#ec4899',
  '#3b82f6',
]);

/**
 * Scene-local monitor transform bounds relative to the station desk surface.
 * - `x`: lateral desk offset in meters (`[-0.78, 0.22]`)
 * - `y`: vertical height offset from ergonomic desk mount center (`[-0.06, 0.24]`)
 * - `z`: depth offset on desk (`[-0.46, 0.22]`)
 * - `yaw`: horizontal heading in radians (`[0.10, 2.15]`, facing worker & isometric camera)
 */
export const OFFICE_MONITOR_TRANSFORM_BOUNDS = Object.freeze({
  x: Object.freeze({ min: -0.78, max: 0.22, step: 0.04 }),
  y: Object.freeze({ min: -0.06, max: 0.24, step: 0.02 }),
  z: Object.freeze({ min: -0.46, max: 0.22, step: 0.04 }),
  yaw: Object.freeze({ min: 0.10, max: 2.15, step: 0.08 }),
});

export const DEFAULT_OFFICE_MONITOR_TRANSFORM: OfficeMonitorTransform = Object.freeze({
  x: -0.42,
  y: 0,
  z: -0.02,
  yaw: 1.05,
});

const DEFAULT_RGB_COLOR = '#00e5ff';

export const DEFAULT_OFFICE_COMPUTER_PREFERENCES: OfficeComputerPreferences = freezePreferences({
  power: 'on',
  wallpaper: 'aurora',
  rgbEnabled: true,
  rgbColor: DEFAULT_RGB_COLOR,
  monitor: DEFAULT_OFFICE_MONITOR_TRANSFORM,
});

const STORAGE_KEY_PREFIX = 'aih:office-computer:v1:';

interface CachedSnapshotEntry {
  raw: string | null;
  snapshot: OfficeComputerPreferences;
}

const snapshotCache = new Map<string, CachedSnapshotEntry>();
const memoryFallbackStorage = new Map<string, string>();
const storageWriteFailedKeys = new Set<string>();
const listeners = new Set<() => void>();

let preferencesRevision = 0;
let storageListenerAttached = false;

function freezeTransform(transform: OfficeMonitorTransform): OfficeMonitorTransform {
  return Object.freeze({
    x: transform.x,
    y: transform.y,
    z: transform.z,
    yaw: transform.yaw,
  });
}

function freezePreferences(prefs: OfficeComputerPreferences): OfficeComputerPreferences {
  return Object.freeze({
    power: prefs.power,
    wallpaper: prefs.wallpaper,
    rgbEnabled: prefs.rgbEnabled,
    rgbColor: prefs.rgbColor,
    monitor: freezeTransform(prefs.monitor),
  });
}

function roundToThree(value: number): number {
  const rounded = Math.round(value * 1000) / 1000;
  return rounded === 0 ? 0 : rounded;
}

function clampAxis(
  value: unknown,
  min: number,
  max: number,
  fallback: number
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback === 0 ? 0 : fallback;
  }
  const clamped = Math.max(min, Math.min(max, value));
  return roundToThree(clamped);
}

export function clampOfficeMonitorTransform(
  input: Partial<OfficeMonitorTransform> | null | undefined,
  fallback: OfficeMonitorTransform = DEFAULT_OFFICE_MONITOR_TRANSFORM
): OfficeMonitorTransform {
  const source = input && typeof input === 'object' ? input : {};
  const bounds = OFFICE_MONITOR_TRANSFORM_BOUNDS;
  return {
    x: clampAxis(source.x, bounds.x.min, bounds.x.max, fallback.x),
    y: clampAxis(source.y, bounds.y.min, bounds.y.max, fallback.y),
    z: clampAxis(source.z, bounds.z.min, bounds.z.max, fallback.z),
    yaw: clampAxis(source.yaw, bounds.yaw.min, bounds.yaw.max, fallback.yaw),
  };
}

function normalizePower(value: unknown, fallback: OfficeComputerPowerState): OfficeComputerPowerState {
  return value === 'off' || value === 'on' ? value : fallback;
}

function normalizeWallpaper(value: unknown, fallback: OfficeWallpaperId): OfficeWallpaperId {
  return value === 'aurora' || value === 'sunset' || value === 'midnight' ? value : fallback;
}

export function normalizeOfficeRgbColor(value: unknown, fallback = DEFAULT_RGB_COLOR): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  if (/^#[0-9a-fA-F]{3}$/.test(trimmed)) {
    const r = trimmed[1];
    const g = trimmed[2];
    const b = trimmed[3];
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  return fallback;
}

function sanitizePreferences(
  rawInput: unknown,
  fallback: OfficeComputerPreferences = DEFAULT_OFFICE_COMPUTER_PREFERENCES
): OfficeComputerPreferences {
  if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) {
    return fallback;
  }
  const candidate = rawInput as Record<string, unknown>;
  // Read the old dual-monitor tuple for migration; only the primary pose survives.
  const legacyMonitors = Array.isArray(candidate.monitors) ? candidate.monitors : [];
  const monitor = clampOfficeMonitorTransform(
    (candidate.monitor ?? legacyMonitors[0]) as Partial<OfficeMonitorTransform> | undefined,
    fallback.monitor
  );

  return freezePreferences({
    power: normalizePower(candidate.power, fallback.power),
    wallpaper: normalizeWallpaper(candidate.wallpaper, fallback.wallpaper),
    rgbEnabled: typeof candidate.rgbEnabled === 'boolean'
      ? candidate.rgbEnabled
      : fallback.rgbEnabled,
    rgbColor: normalizeOfficeRgbColor(candidate.rgbColor, fallback.rgbColor),
    monitor,
  });
}

function areTransformsEqual(a: OfficeMonitorTransform, b: OfficeMonitorTransform): boolean {
  return a.x === b.x && a.y === b.y && a.z === b.z && a.yaw === b.yaw;
}

function arePreferencesEqual(a: OfficeComputerPreferences, b: OfficeComputerPreferences): boolean {
  return (
    a.power === b.power
    && a.wallpaper === b.wallpaper
    && a.rgbEnabled === b.rgbEnabled
    && a.rgbColor === b.rgbColor
    && areTransformsEqual(a.monitor, b.monitor)
  );
}

function safeEncodeKeySegment(segment: string): string {
  try {
    return encodeURIComponent(segment);
  } catch {
    // Unpaired UTF-16 surrogates throw URIError in encodeURIComponent; encode valid scalars/pairs
    // with encodeURIComponent and emit `%uXXXX` directly (encodeURIComponent never emits `%u`).
    let encoded = '';
    for (let i = 0; i < segment.length; i += 1) {
      const code = segment.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = i + 1 < segment.length ? segment.charCodeAt(i + 1) : 0;
        if (next >= 0xdc00 && next <= 0xdfff) {
          encoded += encodeURIComponent(segment[i] + segment[i + 1]);
          i += 1;
          continue;
        }
        encoded += `%u${code.toString(16).toUpperCase()}`;
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        encoded += `%u${code.toString(16).toUpperCase()}`;
      } else {
        encoded += encodeURIComponent(segment[i]);
      }
    }
    return encoded;
  }
}

function buildStorageKey(serverId: string, sessionKey: string): string | null {
  if (typeof serverId !== 'string' || typeof sessionKey !== 'string') {
    return null;
  }
  const sid = serverId.trim();
  const skey = sessionKey.trim();
  if (!sid || !skey) return null;
  return `${STORAGE_KEY_PREFIX}${safeEncodeKeySegment(sid)}:${safeEncodeKeySegment(skey)}`;
}

function safeReadRawStorage(storageKey: string): string | null {
  if (storageWriteFailedKeys.has(storageKey)) {
    return memoryFallbackStorage.get(storageKey) ?? null;
  }
  if (typeof window !== 'undefined') {
    try {
      const value = window.localStorage.getItem(storageKey);
      if (value !== null) {
        return value;
      }
      return null;
    } catch {
      // Storage unavailable or blocked; fall back to in-memory map.
    }
  }
  return memoryFallbackStorage.get(storageKey) ?? null;
}

function safeWriteRawStorage(storageKey: string, serialized: string): void {
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(storageKey, serialized);
      storageWriteFailedKeys.delete(storageKey);
      memoryFallbackStorage.delete(storageKey);
      return;
    } catch {
      // Quota exceeded or private mode; persist in memory fallback for this tab.
    }
  }
  storageWriteFailedKeys.add(storageKey);
  memoryFallbackStorage.set(storageKey, serialized);
}

function notifyListeners(): void {
  preferencesRevision += 1;
  for (const listener of [...listeners]) {
    listener();
  }
}

function handleStorageEvent(event: StorageEvent): void {
  try {
    if (event.storageArea && event.storageArea !== window.localStorage) {
      return;
    }
  } catch {
    return;
  }

  if (event.key === null) {
    snapshotCache.clear();
    memoryFallbackStorage.clear();
    storageWriteFailedKeys.clear();
    notifyListeners();
    return;
  }
  if (!event.key.startsWith(STORAGE_KEY_PREFIX)) {
    return;
  }
  storageWriteFailedKeys.delete(event.key);
  memoryFallbackStorage.delete(event.key);
  snapshotCache.delete(event.key);
  notifyListeners();
}

function ensureStorageListener(): void {
  if (storageListenerAttached || typeof window === 'undefined') return;
  window.addEventListener('storage', handleStorageEvent);
  storageListenerAttached = true;
}

function detachStorageListenerIfIdle(): void {
  if (!storageListenerAttached || listeners.size > 0 || typeof window === 'undefined') return;
  window.removeEventListener('storage', handleStorageEvent);
  storageListenerAttached = false;
}

export function readOfficeComputerPreferences(
  serverId: string,
  sessionKey: string
): OfficeComputerPreferences {
  const storageKey = buildStorageKey(serverId, sessionKey);
  if (!storageKey) {
    return DEFAULT_OFFICE_COMPUTER_PREFERENCES;
  }

  const raw = safeReadRawStorage(storageKey);
  const cached = snapshotCache.get(storageKey);
  if (cached && cached.raw === raw) {
    return cached.snapshot;
  }

  let parsed: unknown = null;
  if (raw !== null) {
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      parsed = null;
    }
  }

  const sanitized = parsed === null
    ? DEFAULT_OFFICE_COMPUTER_PREFERENCES
    : sanitizePreferences(parsed, DEFAULT_OFFICE_COMPUTER_PREFERENCES);

  const snapshot = cached && arePreferencesEqual(cached.snapshot, sanitized)
    ? cached.snapshot
    : sanitized;

  snapshotCache.set(storageKey, { raw, snapshot });
  return snapshot;
}

export function updateOfficeComputerPreferences(
  serverId: string,
  sessionKey: string,
  patch: Partial<OfficeComputerPreferences>
): void {
  const storageKey = buildStorageKey(serverId, sessionKey);
  if (!storageKey || !patch || typeof patch !== 'object') {
    return;
  }

  const current = readOfficeComputerPreferences(serverId, sessionKey);
  const mergedInput: Record<string, unknown> = {
    ...current,
    ...patch,
  };
  if (!patch.monitor) {
    mergedInput.monitor = current.monitor;
  }

  const next = sanitizePreferences(mergedInput, current);
  if (arePreferencesEqual(current, next)) {
    return;
  }

  const serialized = JSON.stringify(next);
  safeWriteRawStorage(storageKey, serialized);
  snapshotCache.set(storageKey, { raw: serialized, snapshot: next });
  notifyListeners();
}

export function resetOfficeComputerMonitor(serverId: string, sessionKey: string): void {
  updateOfficeComputerPreferences(serverId, sessionKey, {
    monitor: { ...DEFAULT_OFFICE_MONITOR_TRANSFORM },
  });
}

export function subscribeOfficeComputerPreferences(listener: () => void): () => void {
  listeners.add(listener);
  ensureStorageListener();
  return () => {
    listeners.delete(listener);
    detachStorageListenerIfIdle();
  };
}

export function readOfficeComputerPreferencesRevision(): number {
  return preferencesRevision;
}
