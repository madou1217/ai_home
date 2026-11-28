import { useCallback, useSyncExternalStore } from 'react';
import type { OfficeComputerPreferences } from './office-computer-state';

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
