import {
  OFFICE_WALLPAPER_META,
  type OfficeWallpaperId,
} from './office-computer-state';

export const MONITOR_TEXTURE_WIDTH = 640;
export const MONITOR_TEXTURE_HEIGHT = 400;

export type OfficeWallpaperRasterResolver = (
  wallpaperId: OfficeWallpaperId
) => string | null | undefined;

function normalizeWallpaperId(wallpaperId: OfficeWallpaperId): OfficeWallpaperId {
  return wallpaperId === 'sunset' || wallpaperId === 'midnight' || wallpaperId === 'aurora'
    ? wallpaperId
    : 'aurora';
}

export const DEFAULT_OFFICE_WALLPAPER_RASTER_RESOLVER: OfficeWallpaperRasterResolver = (
  wallpaperId
) => OFFICE_WALLPAPER_META[normalizeWallpaperId(wallpaperId)].suggestedAssetPath;

interface RasterCacheEntry {
  url: string;
  status: 'loading' | 'loaded' | 'error';
  image: HTMLImageElement | null;
  generation: number;
}

const proceduralBackdropCache = new Map<OfficeWallpaperId, HTMLCanvasElement>();
const rasterCache = new Map<string, RasterCacheEntry>();
const rasterReadyListeners = new Set<() => void>();

let customRasterResolver: OfficeWallpaperRasterResolver | null = DEFAULT_OFFICE_WALLPAPER_RASTER_RESOLVER;
let cacheGeneration = 1;
let rasterVersion = 0;
let activeWallpaperCacheUsers = 0;

/**
 * Registers an optional URL resolver for raster wallpaper assets
 * (for example `(id) => \`/ui/office-assets/computer-v3/wallpaper-\${id}.webp\``).
 * Passing `null` restores pure procedural Canvas wallpapers with zero network requests.
 */
export function registerOfficeWallpaperRasterResolver(
  resolver: OfficeWallpaperRasterResolver | null
): void {
  if (customRasterResolver === resolver) return;
  customRasterResolver = resolver;
  clearRasterEntries();
  rasterVersion += 1;
  notifyRasterListeners();
}

export function getOfficeWallpaperRasterVersion(): number {
  return rasterVersion;
}

export function subscribeOfficeWallpaperRasterReady(listener: () => void): () => void {
  rasterReadyListeners.add(listener);
  return () => {
    rasterReadyListeners.delete(listener);
  };
}

function notifyRasterListeners(): void {
  for (const listener of [...rasterReadyListeners]) {
    listener();
  }
}

function clearRasterEntries(): void {
  cacheGeneration += 1;
  for (const entry of rasterCache.values()) {
    if (entry.image) {
      entry.image.onload = null;
      entry.image.onerror = null;
      entry.image = null;
    }
  }
  rasterCache.clear();
}

export function acquireOfficeWallpaperCacheRef(): void {
  activeWallpaperCacheUsers += 1;
}

export function releaseOfficeWallpaperCacheRef(): void {
  activeWallpaperCacheUsers = Math.max(0, activeWallpaperCacheUsers - 1);
  if (activeWallpaperCacheUsers === 0) {
    disposeOfficeWallpaperCaches();
  }
}

export function disposeOfficeWallpaperCaches(): void {
  clearRasterEntries();
  proceduralBackdropCache.clear();
}

function seededRand(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function paintAuroraBackdrop(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const sky = ctx.createLinearGradient(0, 0, w * 0.25, h);
  sky.addColorStop(0, '#040a16');
  sky.addColorStop(0.5, '#07172b');
  sky.addColorStop(1, '#092434');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);

  // Subtle starfield
  const rng = seededRand(104729);
  for (let i = 0; i < 68; i += 1) {
    const sx = rng() * w;
    const sy = rng() * h * 0.68;
    const r = 0.6 + rng() * 1.1;
    ctx.fillStyle = `rgba(210, 244, 255, ${0.22 + rng() * 0.55})`;
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // Flowing aurora curtains
  const drawCurtain = (
    yBase: number,
    amp: number,
    c1: string,
    c2: string,
    alpha: number
  ) => {
    ctx.save();
    ctx.globalAlpha = alpha;
    const grad = ctx.createLinearGradient(0, yBase - 120, w, yBase + 70);
    grad.addColorStop(0, c1);
    grad.addColorStop(0.55, c2);
    grad.addColorStop(1, 'rgba(0, 229, 255, 0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(0, yBase);
    for (let x = 0; x <= w; x += 24) {
      const wave = Math.sin(x * 0.012 + yBase * 0.02) * amp + Math.cos(x * 0.021) * (amp * 0.45);
      ctx.lineTo(x, yBase + wave);
    }
    ctx.lineTo(w, yBase - 135);
    ctx.lineTo(0, yBase - 110);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  };

  drawCurtain(165, 24, 'rgba(16, 185, 129, 0.72)', 'rgba(0, 229, 255, 0.65)', 0.55);
  drawCurtain(210, 28, 'rgba(56, 189, 248, 0.65)', 'rgba(52, 211, 153, 0.58)', 0.48);

  // Soft radial atmospheric glow
  const glow = ctx.createRadialGradient(w * 0.64, h * 0.34, 10, w * 0.64, h * 0.34, 250);
  glow.addColorStop(0, 'rgba(0, 229, 255, 0.24)');
  glow.addColorStop(0.6, 'rgba(16, 185, 129, 0.08)');
  glow.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, w, h);

  // Clean dark horizon ridge silhouette
  ctx.fillStyle = '#040a12';
  ctx.beginPath();
  ctx.moveTo(0, h);
  ctx.lineTo(0, h * 0.78);
  ctx.lineTo(w * 0.2, h * 0.71);
  ctx.lineTo(w * 0.42, h * 0.79);
  ctx.lineTo(w * 0.68, h * 0.68);
  ctx.lineTo(w * 0.88, h * 0.75);
  ctx.lineTo(w, h * 0.72);
  ctx.lineTo(w, h);
  ctx.closePath();
  ctx.fill();
}

function paintSunsetBackdrop(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const sky = ctx.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, '#120f24');
  sky.addColorStop(0.38, '#3b1d45');
  sky.addColorStop(0.7, '#9c3641');
  sky.addColorStop(1, '#d97724');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);

  // Warm setting solar disc + halo
  const halo = ctx.createRadialGradient(w * 0.62, h * 0.56, 8, w * 0.62, h * 0.56, 200);
  halo.addColorStop(0, 'rgba(255, 224, 150, 0.78)');
  halo.addColorStop(0.32, 'rgba(251, 146, 60, 0.42)');
  halo.addColorStop(1, 'rgba(251, 146, 60, 0)');
  ctx.fillStyle = halo;
  ctx.fillRect(0, 0, w, h);

  ctx.fillStyle = 'rgba(254, 215, 130, 0.85)';
  ctx.beginPath();
  ctx.arc(w * 0.62, h * 0.56, 46, 0, Math.PI * 2);
  ctx.fill();

  // Layered dusk cloud bands
  ctx.fillStyle = 'rgba(255, 186, 128, 0.14)';
  ctx.fillRect(48, h * 0.34, 210, 8);
  ctx.fillRect(340, h * 0.25, 240, 6);
  ctx.fillRect(140, h * 0.46, 170, 5);

  // Distant & foreground twilight ridges
  ctx.fillStyle = 'rgba(42, 18, 44, 0.75)';
  ctx.beginPath();
  ctx.moveTo(0, h);
  ctx.lineTo(0, h * 0.67);
  ctx.lineTo(w * 0.26, h * 0.60);
  ctx.lineTo(w * 0.54, h * 0.69);
  ctx.lineTo(w * 0.82, h * 0.59);
  ctx.lineTo(w, h * 0.65);
  ctx.lineTo(w, h);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = '#140b1c';
  ctx.beginPath();
  ctx.moveTo(0, h);
  ctx.lineTo(0, h * 0.82);
  ctx.lineTo(w * 0.18, h * 0.75);
  ctx.lineTo(w * 0.44, h * 0.83);
  ctx.lineTo(w * 0.72, h * 0.73);
  ctx.lineTo(w, h * 0.80);
  ctx.lineTo(w, h);
  ctx.closePath();
  ctx.fill();
}

function paintMidnightBackdrop(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const sky = ctx.createLinearGradient(0, 0, w, h);
  sky.addColorStop(0, '#050814');
  sky.addColorStop(0.52, '#0c1330');
  sky.addColorStop(1, '#18143a');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);

  // Subtle indigo & violet nebula washes
  const neb1 = ctx.createRadialGradient(w * 0.32, h * 0.36, 10, w * 0.32, h * 0.36, 230);
  neb1.addColorStop(0, 'rgba(99, 102, 241, 0.32)');
  neb1.addColorStop(1, 'rgba(99, 102, 241, 0)');
  ctx.fillStyle = neb1;
  ctx.fillRect(0, 0, w, h);

  const neb2 = ctx.createRadialGradient(w * 0.75, h * 0.58, 10, w * 0.75, h * 0.58, 220);
  neb2.addColorStop(0, 'rgba(139, 92, 246, 0.28)');
  neb2.addColorStop(1, 'rgba(139, 92, 246, 0)');
  ctx.fillStyle = neb2;
  ctx.fillRect(0, 0, w, h);

  // Fine starfield
  const rng = seededRand(299792);
  for (let i = 0; i < 95; i += 1) {
    const sx = rng() * w;
    const sy = rng() * h * 0.86;
    const r = 0.5 + rng() * 1.15;
    ctx.fillStyle = `rgba(226, 232, 255, ${0.24 + rng() * 0.65})`;
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // Crisp orbital arc accent
  ctx.save();
  ctx.strokeStyle = 'rgba(129, 140, 248, 0.35)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.ellipse(w * 0.56, h * 0.82, 280, 120, -0.14, Math.PI * 1.05, Math.PI * 1.92);
  ctx.stroke();

  ctx.strokeStyle = 'rgba(196, 181, 253, 0.2)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.ellipse(w * 0.56, h * 0.82, 315, 140, -0.14, Math.PI * 1.08, Math.PI * 1.88);
  ctx.stroke();
  ctx.restore();
}

function getProceduralWallpaperCanvas(wallpaperId: OfficeWallpaperId): HTMLCanvasElement {
  const safeId = normalizeWallpaperId(wallpaperId);
  const existing = proceduralBackdropCache.get(safeId);
  if (existing) return existing;

  const canvas = document.createElement('canvas');
  canvas.width = MONITOR_TEXTURE_WIDTH;
  canvas.height = MONITOR_TEXTURE_HEIGHT;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    switch (safeId) {
      case 'aurora':
        paintAuroraBackdrop(ctx, MONITOR_TEXTURE_WIDTH, MONITOR_TEXTURE_HEIGHT);
        break;
      case 'sunset':
        paintSunsetBackdrop(ctx, MONITOR_TEXTURE_WIDTH, MONITOR_TEXTURE_HEIGHT);
        break;
      case 'midnight':
        paintMidnightBackdrop(ctx, MONITOR_TEXTURE_WIDTH, MONITOR_TEXTURE_HEIGHT);
        break;
      default:
        paintAuroraBackdrop(ctx, MONITOR_TEXTURE_WIDTH, MONITOR_TEXTURE_HEIGHT);
        break;
    }
  }
  proceduralBackdropCache.set(safeId, canvas);
  return canvas;
}

function requestOptionalRasterWallpaper(wallpaperId: OfficeWallpaperId): HTMLImageElement | null {
  if (!customRasterResolver || typeof Image === 'undefined') {
    return null;
  }
  const safeId = normalizeWallpaperId(wallpaperId);
  const url = customRasterResolver(safeId);
  if (!url || !url.trim()) {
    return null;
  }
  const normalizedUrl = url.trim();
  const cached = rasterCache.get(normalizedUrl);
  if (cached) {
    return cached.status === 'loaded' ? cached.image : null;
  }

  const gen = cacheGeneration;
  const img = new Image();
  const entry: RasterCacheEntry = {
    url: normalizedUrl,
    status: 'loading',
    image: img,
    generation: gen,
  };
  rasterCache.set(normalizedUrl, entry);

  img.onload = () => {
    if (entry.generation !== cacheGeneration) return;
    if (img.naturalWidth <= 0 || img.naturalHeight <= 0) {
      entry.status = 'error';
      entry.image = null;
      return;
    }
    entry.status = 'loaded';
    rasterVersion += 1;
    notifyRasterListeners();
  };
  img.onerror = () => {
    if (entry.generation !== cacheGeneration) return;
    entry.status = 'error';
    entry.image = null;
  };
  img.src = normalizedUrl;

  return null;
}

export function drawMonitorWallpaperBackdrop(
  ctx: CanvasRenderingContext2D,
  wallpaperId: OfficeWallpaperId,
  width: number,
  height: number
): boolean {
  const rasterImage = requestOptionalRasterWallpaper(wallpaperId);
  if (rasterImage && rasterImage.complete && rasterImage.naturalWidth > 0) {
    // Cover-crop onto monitor canvas
    const imgRatio = rasterImage.naturalWidth / rasterImage.naturalHeight;
    const dstRatio = width / height;
    let sx = 0;
    let sy = 0;
    let sw = rasterImage.naturalWidth;
    let sh = rasterImage.naturalHeight;
    if (imgRatio > dstRatio) {
      sw = rasterImage.naturalHeight * dstRatio;
      sx = (rasterImage.naturalWidth - sw) * 0.5;
    } else if (imgRatio < dstRatio) {
      sh = rasterImage.naturalWidth / dstRatio;
      sy = (rasterImage.naturalHeight - sh) * 0.5;
    }
    ctx.drawImage(rasterImage, sx, sy, sw, sh, 0, 0, width, height);
    return true;
  }

  const fallbackCanvas = getProceduralWallpaperCanvas(wallpaperId);
  ctx.drawImage(fallbackCanvas, 0, 0, width, height);
  return false;
}
