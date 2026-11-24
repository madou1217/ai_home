import * as THREE from 'three';
import type { OfficeSessionItem, SessionAvailability } from './session-office-types';
import type { OfficeScenePalette, OfficeSceneSyncState } from './office-scene-types';
import {
  OFFICE_WALLPAPER_META,
  type OfficeComputerPowerState,
  type OfficeWallpaperId,
} from './office-computer-state';
import {
  drawMonitorWallpaperBackdrop,
} from './office-computer-wallpapers';

/**
 * 像素风 2D Canvas 纹理生成器（显示器实时会话预览、墙面铭牌、房间终端、桌面工位牌）。
 * 所有贴图严格启用 NearestFilter、禁用 mipmap、SRGBColorSpace 与各向异性过滤（>= 4），
 * 显示器采用 1024×640 高清画布、大号等宽像素字体（标题 >= 26px、正文 >= 20px）与 >= 7:1 深底亮字高对比排版。
 */

export interface CanvasTextureBundle {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  texture: THREE.CanvasTexture;
  lastSignature: string;
}

export interface MonitorScreenTextureOptions {
  power: OfficeComputerPowerState;
  wallpaper: OfficeWallpaperId;
  monitorIndex: 0 | 1;
  dualMonitor: boolean;
  rasterVersion: number;
}

export const OFFICE_MONITOR_CANVAS_WIDTH = 1024;
export const OFFICE_MONITOR_CANVAS_HEIGHT = 640;

const SCREEN_W = OFFICE_MONITOR_CANVAS_WIDTH;
const SCREEN_H = OFFICE_MONITOR_CANVAS_HEIGHT;

const DEFAULT_SCREEN_OPTIONS: MonitorScreenTextureOptions = {
  power: 'on',
  wallpaper: 'aurora',
  monitorIndex: 0,
  dualMonitor: false,
  rasterVersion: 0,
};

const PIXEL_FONT_STACK = '"JetBrains Mono", "Fira Code", "Consolas", "PingFang SC", "Microsoft YaHei", monospace';

// 高对比深底亮字色板（在 #070c16 面板底色上全部满足 WCAG AAA 对比度 >= 7:1）
const SCREEN_PANEL_BG = 'rgba(7, 12, 22, 0.95)';
const SCREEN_HEADER_BG = '#070c16';
const SCREEN_TEXT_BRIGHT = '#f8fbff';
const SCREEN_TEXT_LABEL = '#c8dcf2';
const SCREEN_CYAN_BRIGHT = '#67f3ff';
const SCREEN_GREEN_BRIGHT = '#63f592';
const SCREEN_AMBER_BRIGHT = '#ffd25a';
const SCREEN_DANGER_BRIGHT = '#ff8ca3';
const SCREEN_VIOLET_BRIGHT = '#d8b4fe';
const SCREEN_EXITED_BRIGHT = '#cddcf0';

function createPixelCanvasBundle(
  width: number,
  height: number,
  anisotropy: number
): CanvasTextureBundle {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('2D canvas context unavailable for 3D scene textures');
  }
  ctx.imageSmoothingEnabled = false;

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.anisotropy = Math.max(4, Math.floor(anisotropy || 4));

  return {
    canvas,
    ctx,
    texture,
    lastSignature: '',
  };
}

/** 绘制 Minecraft GUI 风格的硬边像素边框面板（无圆角、无渐变） */
function drawPixelPanel(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  fill: string,
  borderLight: string,
  borderDark: string,
  borderPx = 2
): void {
  ctx.fillStyle = fill;
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = borderLight;
  ctx.fillRect(x, y, w, borderPx);
  ctx.fillRect(x, y, borderPx, h);
  ctx.fillStyle = borderDark;
  ctx.fillRect(x, y + h - borderPx, w, borderPx);
  ctx.fillRect(x + w - borderPx, y, borderPx, h);
}

function truncateToWidth(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number
): string {
  if (!text) return '';
  if (ctx.measureText(text).width <= maxWidth) return text;
  const ellipsis = '…';
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const candidate = `${text.slice(0, mid)}${ellipsis}`;
    if (ctx.measureText(candidate).width <= maxWidth) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return lo <= 0 ? ellipsis : `${text.slice(0, lo)}${ellipsis}`;
}

function wrapCanvasLines(
  ctx: CanvasRenderingContext2D,
  rawText: string,
  maxWidth: number,
  maxLines: number
): string[] {
  const normalized = rawText.replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];

  const paragraphs = normalized.split('\n');
  const lines: string[] = [];

  for (let pIdx = 0; pIdx < paragraphs.length; pIdx += 1) {
    const paragraph = paragraphs[pIdx].replace(/\s+/g, ' ').trim();
    if (!paragraph) continue;

    let current = '';
    for (let i = 0; i < paragraph.length; i += 1) {
      const ch = paragraph[i];
      const next = current + ch;
      if (ctx.measureText(next).width > maxWidth && current.length > 0) {
        lines.push(current);
        current = ch === ' ' ? '' : ch;
        if (lines.length >= maxLines) {
          const remaining = paragraph.slice(i);
          if (remaining.trim()) {
            lines[maxLines - 1] = truncateToWidth(
              ctx,
              `${lines[maxLines - 1]} ${remaining.trim()}`,
              maxWidth
            );
          }
          return lines;
        }
      } else {
        current = next;
      }
    }
    if (current) {
      lines.push(current);
      if (lines.length >= maxLines) {
        const hasMoreParagraphs = paragraphs.slice(pIdx + 1).some((p) => p.trim().length > 0);
        if (hasMoreParagraphs) {
          lines[maxLines - 1] = truncateToWidth(ctx, `${lines[maxLines - 1]}…`, maxWidth);
        }
        return lines;
      }
    }
  }

  return lines;
}

function formatCompactPath(cwd: string): string {
  const trimmed = cwd.trim();
  if (!trimmed || trimmed === '__no_cwd__') return '';
  if (trimmed.length <= 36) return trimmed;
  const parts = trimmed.split('/').filter(Boolean);
  if (parts.length <= 3) return trimmed;
  return `…/${parts.slice(-3).join('/')}`;
}

function getAvailabilityBadge(
  availability: SessionAvailability
): { label: string; color: string; bg: string } {
  switch (availability) {
    case 'interactive':
      return { label: '运行中', color: SCREEN_GREEN_BRIGHT, bg: '#092416' };
    case 'directory-only':
      return { label: '目录在线', color: SCREEN_CYAN_BRIGHT, bg: '#082230' };
    case 'unavailable':
      return { label: '标识保留', color: SCREEN_AMBER_BRIGHT, bg: '#261a05' };
    case 'exited':
      return { label: '已退出', color: SCREEN_EXITED_BRIGHT, bg: '#131c2b' };
  }
}

function resolveWallpaperMetadata(wallpaperId: OfficeWallpaperId) {
  return wallpaperId === 'sunset' || wallpaperId === 'midnight' || wallpaperId === 'aurora'
    ? OFFICE_WALLPAPER_META[wallpaperId]
    : OFFICE_WALLPAPER_META.aurora;
}

/** 绘制 1024×640 像素化壁纸背景（兼容光栅化接口），叠加深色遮罩确保高对比可读 */
function paintPixelatedWallpaper(
  ctx: CanvasRenderingContext2D,
  wallpaperId: OfficeWallpaperId
): void {
  drawMonitorWallpaperBackdrop(ctx, wallpaperId, SCREEN_W, SCREEN_H);
  ctx.fillStyle = 'rgba(5, 9, 18, 0.56)';
  ctx.fillRect(0, 0, SCREEN_W, SCREEN_H);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.14)';
  for (let y = 0; y < SCREEN_H; y += 12) {
    ctx.fillRect(0, y, SCREEN_W, 2);
  }
}

function renderPoweredOffScreen(
  ctx: CanvasRenderingContext2D,
  isSelected: boolean
): void {
  ctx.fillStyle = '#090e17';
  ctx.fillRect(0, 0, SCREEN_W, SCREEN_H);

  // 像素棋盘暗纹
  ctx.fillStyle = '#0f1624';
  for (let y = 24; y < SCREEN_H - 24; y += 48) {
    for (let x = 24; x < SCREEN_W - 24; x += 48) {
      ctx.fillRect(x, y, 24, 24);
    }
  }

  // 外框像素边框
  ctx.strokeStyle = isSelected ? SCREEN_CYAN_BRIGHT : '#354966';
  ctx.lineWidth = isSelected ? 6 : 4;
  ctx.strokeRect(10, 10, SCREEN_W - 20, SCREEN_H - 20);

  // 像素风格电源方块图标（全矩形，无圆弧）
  const cx = Math.floor(SCREEN_W / 2);
  const cy = Math.floor(SCREEN_H / 2) - 34;
  ctx.fillStyle = isSelected ? SCREEN_CYAN_BRIGHT : '#8fa9c7';
  ctx.fillRect(cx - 34, cy - 20, 10, 52);
  ctx.fillRect(cx + 24, cy - 20, 10, 52);
  ctx.fillRect(cx - 34, cy + 22, 68, 10);
  ctx.fillRect(cx - 5, cy - 38, 10, 38);

  ctx.font = `700 36px ${PIXEL_FONT_STACK}`;
  ctx.fillStyle = isSelected ? SCREEN_CYAN_BRIGHT : '#c4d6ec';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('POWER OFF · CLICK TO BOOT', SCREEN_W / 2, cy + 88);
  ctx.textAlign = 'left';
}

function renderSecondaryCompanionScreen(
  ctx: CanvasRenderingContext2D,
  session: OfficeSessionItem,
  isSelected: boolean,
  options: MonitorScreenTextureOptions
): void {
  const wpMeta = resolveWallpaperMetadata(options.wallpaper);
  const availBadge = getAvailabilityBadge(session.availability);
  const displayCwd = formatCompactPath(session.cwd) || '未登记工作目录';

  // 外边框
  ctx.strokeStyle = isSelected ? SCREEN_CYAN_BRIGHT : '#4c6d94';
  ctx.lineWidth = 6;
  ctx.strokeRect(6, 6, SCREEN_W - 12, SCREEN_H - 12);

  // 顶栏（副屏标题 + 会话名）
  drawPixelPanel(ctx, 20, 20, SCREEN_W - 40, 114, SCREEN_HEADER_BG, '#3d5f8a', '#03060c', 4);
  ctx.textBaseline = 'middle';

  ctx.font = `700 30px ${PIXEL_FONT_STACK}`;
  ctx.fillStyle = SCREEN_CYAN_BRIGHT;
  ctx.fillText('DISPLAY 2', 42, 77);

  ctx.font = `700 44px ${PIXEL_FONT_STACK}`;
  ctx.fillStyle = SCREEN_TEXT_BRIGHT;
  ctx.textAlign = 'right';
  ctx.fillText(truncateToWidth(ctx, session.shortLabel, SCREEN_W - 300), SCREEN_W - 42, 77);
  ctx.textAlign = 'left';

  // 中部状态与工作目录卡
  drawPixelPanel(ctx, 20, 156, SCREEN_W - 40, 214, SCREEN_PANEL_BG, '#3d5f8a', '#03060c', 4);

  // 状态徽章
  const statusPillW = 240;
  drawPixelPanel(ctx, 42, 178, statusPillW, 56, availBadge.bg, availBadge.color, '#03060c', 3);
  ctx.fillStyle = availBadge.color;
  ctx.fillRect(58, 196, 18, 18);
  ctx.font = `700 30px ${PIXEL_FONT_STACK}`;
  ctx.fillText(availBadge.label, 88, 207);

  ctx.font = `700 28px ${PIXEL_FONT_STACK}`;
  ctx.fillStyle = SCREEN_TEXT_LABEL;
  ctx.textAlign = 'right';
  ctx.fillText(truncateToWidth(ctx, wpMeta.label, 300), SCREEN_W - 42, 207);
  ctx.textAlign = 'left';

  // CWD 正文
  ctx.font = `700 26px ${PIXEL_FONT_STACK}`;
  ctx.fillStyle = SCREEN_CYAN_BRIGHT;
  ctx.fillText('CWD', 42, 266);

  ctx.font = `700 34px ${PIXEL_FONT_STACK}`;
  ctx.fillStyle = SCREEN_TEXT_BRIGHT;
  const cwdLines = wrapCanvasLines(ctx, displayCwd, SCREEN_W - 140, 2);
  let cwdY = 308;
  for (const line of cwdLines) {
    ctx.fillText(line, 42, cwdY);
    cwdY += 44;
  }

  // 下部双列收件 / 发件计数卡
  const cardY = 392;
  const cardH = 224;
  const gap = 22;
  const halfCardW = Math.floor((SCREEN_W - 40 - gap) / 2);

  drawPixelPanel(ctx, 20, cardY, halfCardW, cardH, SCREEN_PANEL_BG, '#3d5f8a', '#03060c', 4);
  ctx.font = `700 30px ${PIXEL_FONT_STACK}`;
  ctx.fillStyle = SCREEN_TEXT_LABEL;
  ctx.fillText('收件 INBOX', 44, cardY + 46);
  ctx.font = `700 74px ${PIXEL_FONT_STACK}`;
  ctx.fillStyle = session.inboxCount > 0 ? SCREEN_CYAN_BRIGHT : SCREEN_TEXT_BRIGHT;
  ctx.fillText(String(session.inboxCount), 44, cardY + 136);
  if (session.pendingCount > 0) {
    ctx.font = `700 28px ${PIXEL_FONT_STACK}`;
    ctx.fillStyle = SCREEN_AMBER_BRIGHT;
    ctx.textAlign = 'right';
    ctx.fillText(`待投 +${session.pendingCount}`, 20 + halfCardW - 24, cardY + 144);
    ctx.textAlign = 'left';
  }

  const rightX = 20 + halfCardW + gap;
  drawPixelPanel(ctx, rightX, cardY, halfCardW, cardH, SCREEN_PANEL_BG, '#3d5f8a', '#03060c', 4);
  ctx.font = `700 30px ${PIXEL_FONT_STACK}`;
  ctx.fillStyle = SCREEN_TEXT_LABEL;
  ctx.fillText('发件 SENT', rightX + 24, cardY + 46);
  ctx.font = `700 74px ${PIXEL_FONT_STACK}`;
  ctx.fillStyle = session.activity.kind === 'outgoing' ? SCREEN_VIOLET_BRIGHT : SCREEN_TEXT_BRIGHT;
  ctx.fillText(String(session.sentCount), rightX + 24, cardY + 136);
  if (session.activity.failedCount > 0) {
    ctx.font = `700 28px ${PIXEL_FONT_STACK}`;
    ctx.fillStyle = SCREEN_DANGER_BRIGHT;
    ctx.textAlign = 'right';
    ctx.fillText(`失败 ${session.activity.failedCount}`, rightX + halfCardW - 24, cardY + 144);
    ctx.textAlign = 'left';
  }
}

export function createMonitorScreenBundle(anisotropy: number): CanvasTextureBundle {
  return createPixelCanvasBundle(SCREEN_W, SCREEN_H, anisotropy);
}

export function updateMonitorScreenTexture(
  bundle: CanvasTextureBundle,
  session: OfficeSessionItem,
  isSelected: boolean,
  palette: OfficeScenePalette,
  options: MonitorScreenTextureOptions = DEFAULT_SCREEN_OPTIONS
): boolean {
  if (options.power === 'off') {
    const offSignature = `off|${palette.mode}|${isSelected ? '1' : '0'}|${options.monitorIndex}`;
    if (bundle.lastSignature === offSignature) {
      return false;
    }
    bundle.lastSignature = offSignature;
    const { ctx } = bundle;
    ctx.clearRect(0, 0, SCREEN_W, SCREEN_H);
    renderPoweredOffScreen(ctx, isSelected);
    bundle.texture.needsUpdate = true;
    return true;
  }

  const displayCwd = formatCompactPath(session.cwd) || '未登记工作目录';
  const signature = [
    'on-v3',
    options.wallpaper,
    String(options.monitorIndex),
    options.dualMonitor ? '2' : '1',
    String(options.rasterVersion),
    palette.mode,
    isSelected ? '1' : '0',
    session.shortLabel,
    session.availability,
    displayCwd,
    String(session.inboxCount),
    String(session.sentCount),
    String(session.pendingCount),
    String(session.activity.failedCount),
    session.activity.kind,
  ].join('|');

  if (bundle.lastSignature === signature) {
    return false;
  }
  bundle.lastSignature = signature;

  const { ctx } = bundle;
  ctx.clearRect(0, 0, SCREEN_W, SCREEN_H);

  // 绘制 1024×640 壁纸底图（支持光栅资产热刷新）
  paintPixelatedWallpaper(ctx, options.wallpaper);

  if (options.monitorIndex === 1) {
    renderSecondaryCompanionScreen(ctx, session, isSelected, options);
    bundle.texture.needsUpdate = true;
    return true;
  }

  const availBadge = getAvailabilityBadge(session.availability);

  // 像素外框
  ctx.strokeStyle = isSelected ? SCREEN_CYAN_BRIGHT : '#4c6d94';
  ctx.lineWidth = isSelected ? 6 : 4;
  ctx.strokeRect(6, 6, SCREEN_W - 12, SCREEN_H - 12);

  // 1. 顶部标题栏：会话名（54px 亮白粗体）+ 状态徽章（32px）
  drawPixelPanel(ctx, 20, 20, SCREEN_W - 40, 124, SCREEN_HEADER_BG, isSelected ? SCREEN_CYAN_BRIGHT : '#3d5f8a', '#03060c', 4);
  ctx.textBaseline = 'middle';

  // 状态指示方块灯
  ctx.fillStyle = availBadge.color;
  ctx.fillRect(42, 68, 24, 24);

  // 右侧状态徽章
  ctx.font = `700 32px ${PIXEL_FONT_STACK}`;
  const statusPillW = Math.max(196, Math.ceil(ctx.measureText(availBadge.label).width) + 48);
  const statusPillX = SCREEN_W - 38 - statusPillW;
  drawPixelPanel(ctx, statusPillX, 46, statusPillW, 70, availBadge.bg, availBadge.color, '#03060c', 3);
  ctx.fillStyle = availBadge.color;
  ctx.textAlign = 'center';
  ctx.fillText(availBadge.label, statusPillX + statusPillW / 2, 82);
  ctx.textAlign = 'left';

  // 会话名主标题（54px 等宽像素粗体，深底亮白高对比）
  const titleMaxW = statusPillX - 102;
  ctx.font = `700 54px ${PIXEL_FONT_STACK}`;
  ctx.fillStyle = SCREEN_TEXT_BRIGHT;
  ctx.fillText(truncateToWidth(ctx, session.shortLabel, titleMaxW), 84, 82);

  // 2. 中部工作目录卡（CWD 38px 亮字，最多 2 行清晰排版）
  const cwdCardY = 166;
  const cwdCardH = 228;
  drawPixelPanel(ctx, 20, cwdCardY, SCREEN_W - 40, cwdCardH, SCREEN_PANEL_BG, '#486f9e', '#03060c', 4);

  ctx.font = `700 28px ${PIXEL_FONT_STACK}`;
  ctx.fillStyle = SCREEN_CYAN_BRIGHT;
  ctx.fillText('CWD', 46, cwdCardY + 42);

  ctx.fillStyle = '#2e4a6e';
  ctx.fillRect(42, cwdCardY + 70, SCREEN_W - 84, 4);

  ctx.font = `700 38px ${PIXEL_FONT_STACK}`;
  ctx.fillStyle = session.availability === 'exited' ? SCREEN_EXITED_BRIGHT : SCREEN_TEXT_BRIGHT;
  const cwdLines = wrapCanvasLines(ctx, displayCwd, SCREEN_W - 92, 2);
  let lineY = cwdCardY + 122;
  for (const line of cwdLines) {
    ctx.fillText(line, 46, lineY);
    lineY += 54;
  }

  // 3. 底部收件 / 发件大号计数面板（无杂乱小字，仅保留可读字段）
  const statY = 416;
  const statH = 200;
  const statGap = 22;
  const statW = Math.floor((SCREEN_W - 40 - statGap) / 2);

  // 收件卡
  const hasInboxAlert = session.pendingCount > 0;
  drawPixelPanel(
    ctx,
    20,
    statY,
    statW,
    statH,
    SCREEN_PANEL_BG,
    hasInboxAlert ? SCREEN_AMBER_BRIGHT : '#486f9e',
    '#03060c',
    4
  );
  ctx.font = `700 30px ${PIXEL_FONT_STACK}`;
  ctx.fillStyle = SCREEN_TEXT_LABEL;
  ctx.fillText('收件 INBOX', 46, statY + 46);

  ctx.font = `700 72px ${PIXEL_FONT_STACK}`;
  ctx.fillStyle = session.inboxCount > 0 ? SCREEN_CYAN_BRIGHT : SCREEN_TEXT_BRIGHT;
  ctx.fillText(String(session.inboxCount), 46, statY + 132);

  if (session.pendingCount > 0) {
    const pendText = `待投 +${session.pendingCount}`;
    ctx.font = `700 28px ${PIXEL_FONT_STACK}`;
    const pendW = Math.ceil(ctx.measureText(pendText).width) + 32;
    const pendX = 20 + statW - 22 - pendW;
    drawPixelPanel(ctx, pendX, statY + 104, pendW, 56, '#261a05', SCREEN_AMBER_BRIGHT, '#03060c', 3);
    ctx.fillStyle = SCREEN_AMBER_BRIGHT;
    ctx.textAlign = 'center';
    ctx.fillText(pendText, pendX + pendW / 2, statY + 133);
    ctx.textAlign = 'left';
  }

  // 发件卡
  const rightStatX = 20 + statW + statGap;
  drawPixelPanel(
    ctx,
    rightStatX,
    statY,
    statW,
    statH,
    SCREEN_PANEL_BG,
    session.activity.failedCount > 0 ? SCREEN_DANGER_BRIGHT : '#486f9e',
    '#03060c',
    4
  );
  ctx.font = `700 30px ${PIXEL_FONT_STACK}`;
  ctx.fillStyle = SCREEN_TEXT_LABEL;
  ctx.fillText('发件 SENT', rightStatX + 26, statY + 46);

  ctx.font = `700 72px ${PIXEL_FONT_STACK}`;
  ctx.fillStyle = session.activity.kind === 'outgoing' ? SCREEN_VIOLET_BRIGHT : SCREEN_TEXT_BRIGHT;
  ctx.fillText(String(session.sentCount), rightStatX + 26, statY + 132);

  if (session.activity.failedCount > 0) {
    const failText = `失败 ${session.activity.failedCount}`;
    ctx.font = `700 28px ${PIXEL_FONT_STACK}`;
    const failW = Math.ceil(ctx.measureText(failText).width) + 32;
    const failX = rightStatX + statW - 22 - failW;
    drawPixelPanel(ctx, failX, statY + 104, failW, 56, '#290d16', SCREEN_DANGER_BRIGHT, '#03060c', 3);
    ctx.fillStyle = SCREEN_DANGER_BRIGHT;
    ctx.textAlign = 'center';
    ctx.fillText(failText, failX + failW / 2, statY + 133);
    ctx.textAlign = 'left';
  }

  bundle.texture.needsUpdate = true;
  return true;
}

/** 桌面工位像素铭牌（同步放大画布与字号，保持清晰协调且不压过主显示器） */
export function createDeskBadgeBundle(anisotropy: number): CanvasTextureBundle {
  return createPixelCanvasBundle(384, 120, anisotropy);
}

export function updateDeskBadgeTexture(
  bundle: CanvasTextureBundle,
  badgeCode: string,
  accentHex: string,
  palette: OfficeScenePalette
): boolean {
  const sig = `v3|${palette.mode}|${badgeCode}|${accentHex}`;
  if (bundle.lastSignature === sig) return false;
  bundle.lastSignature = sig;

  const { ctx } = bundle;
  // 深色橡木告示牌底色 + 像素描边
  drawPixelPanel(ctx, 0, 0, 384, 120, '#24170c', '#8c643b', '#140c06', 8);
  ctx.strokeStyle = accentHex;
  ctx.lineWidth = 5;
  ctx.strokeRect(14, 14, 356, 92);

  ctx.font = `700 48px ${PIXEL_FONT_STACK}`;
  ctx.fillStyle = '#fff9eb';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(truncateToWidth(ctx, badgeCode || 'BAY', 324), 192, 62);
  ctx.textAlign = 'left';

  bundle.texture.needsUpdate = true;
  return true;
}

/** 墙面项目房间铭牌（嵌墙方块告示牌，像素清晰中文与数字） */
export function createWallPlaqueBundle(anisotropy: number): CanvasTextureBundle {
  return createPixelCanvasBundle(768, 224, anisotropy);
}

export function updateWallPlaqueTexture(
  bundle: CanvasTextureBundle,
  state: OfficeSceneSyncState,
  palette: OfficeScenePalette
): boolean {
  const sig = [
    palette.mode,
    state.roomName,
    state.projectPath,
    state.isFallbackRoom ? '1' : '0',
    String(state.totalSessionCount),
    String(state.runningCount),
    String(state.crossProjectMailCount),
  ].join('|');
  if (bundle.lastSignature === sig) return false;
  bundle.lastSignature = sig;

  const { ctx } = bundle;
  // 贴墙深橡木告示牌风格（暖木色边框与深棕牌面，避免在走廊视角显得像漂浮黑块）
  const bgFill = palette.mode === 'light' ? '#36271b' : '#261d15';
  const rimLight = palette.mode === 'light' ? '#a67b4b' : '#805d38';
  drawPixelPanel(ctx, 0, 0, 768, 224, bgFill, rimLight, '#140e09', 8);
  ctx.strokeStyle = palette.accentHex;
  ctx.lineWidth = 4;
  ctx.strokeRect(12, 12, 744, 200);

  // 四角金块铆钉装饰
  ctx.fillStyle = '#f5cc2c';
  ctx.fillRect(20, 20, 10, 10);
  ctx.fillRect(738, 20, 10, 10);
  ctx.fillRect(20, 194, 10, 10);
  ctx.fillRect(738, 194, 10, 10);

  ctx.textBaseline = 'middle';
  ctx.font = `700 24px ${PIXEL_FONT_STACK}`;
  ctx.fillStyle = palette.accentHex;
  ctx.fillText('PROJECT ROOM', 40, 48);

  ctx.font = `700 48px ${PIXEL_FONT_STACK}`;
  ctx.fillStyle = '#fff9ed';
  ctx.fillText(truncateToWidth(ctx, state.roomName.toUpperCase(), 686), 40, 112);

  const subParts = [
    `${state.totalSessionCount} 工位`,
    `${state.runningCount} 运行`,
    state.crossProjectMailCount > 0 ? `跨室 ${state.crossProjectMailCount}` : '',
    state.isFallbackRoom ? '通用工区' : formatCompactPath(state.projectPath),
  ].filter(Boolean);

  ctx.font = `700 24px ${PIXEL_FONT_STACK}`;
  ctx.fillStyle = '#e0d3bd';
  ctx.fillText(truncateToWidth(ctx, subParts.join(' · '), 686), 40, 174);

  bundle.texture.needsUpdate = true;
  return true;
}

/** 房间邮件终端贴墙方块屏幕（紧凑高对比像素面板，适合 ≤ 2×1 体素贴墙尺寸） */
export function createRoomTerminalBundle(anisotropy: number): CanvasTextureBundle {
  return createPixelCanvasBundle(448, 304, anisotropy);
}

export function updateRoomTerminalTexture(
  bundle: CanvasTextureBundle,
  state: OfficeSceneSyncState,
  palette: OfficeScenePalette
): boolean {
  const sig = [
    palette.mode,
    String(state.roomMessageCount),
    String(state.pendingMailCount),
    String(state.crossProjectMailCount),
    state.hasRecentPulse ? '1' : '0',
  ].join('|');
  if (bundle.lastSignature === sig) return false;
  bundle.lastSignature = sig;

  const { ctx } = bundle;
  const frameColor = state.hasRecentPulse ? palette.successHex : palette.accentHex;
  const panelBg = palette.mode === 'light' ? '#1c2b42' : '#142033';
  const rowBg = palette.mode === 'light' ? '#253854' : '#1d2d47';
  drawPixelPanel(ctx, 0, 0, 448, 304, panelBg, frameColor, '#0b1220', 8);

  ctx.textBaseline = 'middle';
  ctx.font = `700 24px ${PIXEL_FONT_STACK}`;
  ctx.fillStyle = frameColor;
  ctx.fillText('ROOM MAIL', 26, 40);

  // 状态方块灯
  ctx.fillStyle = state.hasRecentPulse ? palette.successHex : palette.accentHex;
  ctx.fillRect(398, 28, 22, 22);

  const drawStat = (label: string, val: string, y: number, color: string) => {
    drawPixelPanel(ctx, 24, y, 400, 52, rowBg, '#4a6b94', '#0e1726', 2);

    ctx.font = `700 22px ${PIXEL_FONT_STACK}`;
    ctx.fillStyle = '#dceaff';
    ctx.fillText(label, 40, y + 27);

    ctx.font = `700 30px ${PIXEL_FONT_STACK}`;
    ctx.fillStyle = color;
    ctx.textAlign = 'right';
    ctx.fillText(val, 406, y + 27);
    ctx.textAlign = 'left';
  };

  drawStat('房间邮件', String(state.roomMessageCount), 72, '#ffffff');
  drawStat(
    '待投队列',
    String(state.pendingMailCount),
    134,
    state.pendingMailCount > 0 ? palette.warningHex : '#ffffff'
  );
  drawStat(
    '跨室协作',
    String(state.crossProjectMailCount),
    196,
    state.crossProjectMailCount > 0 ? palette.violetHex : '#ffffff'
  );

  ctx.font = `700 20px ${PIXEL_FONT_STACK}`;
  ctx.fillStyle = palette.accentHex;
  ctx.fillText('点击打开房间协作邮箱', 26, 274);

  bundle.texture.needsUpdate = true;
  return true;
}
