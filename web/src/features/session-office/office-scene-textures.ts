import * as THREE from 'three';
import type { OfficeSessionItem, SessionAvailability } from './session-office-types';
import type { OfficeScenePalette, OfficeSceneSyncState } from './office-scene-types';
import type { OfficeComputerPowerState } from './office-computer-state';

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
}

export const OFFICE_MONITOR_CANVAS_WIDTH = 1024;
export const OFFICE_MONITOR_CANVAS_HEIGHT = 640;

const SCREEN_W = OFFICE_MONITOR_CANVAS_WIDTH;
const SCREEN_H = OFFICE_MONITOR_CANVAS_HEIGHT;

const DEFAULT_SCREEN_OPTIONS: MonitorScreenTextureOptions = {
  power: 'on',
};

const PIXEL_FONT_STACK = '"JetBrains Mono", "Fira Code", "Consolas", "PingFang SC", "Microsoft YaHei", monospace';

// 高对比深底亮字色板（在 #070c16 面板底色上全部满足 WCAG AAA 对比度 >= 7:1）
const SCREEN_PANEL_BG = 'rgba(7, 12, 22, 0.95)';
const SCREEN_HEADER_BG = '#070c16';
const SCREEN_TEXT_BRIGHT = '#f8fbff';
const SCREEN_TEXT_LABEL = '#c8dcf2';
const SCREEN_CYAN_BRIGHT = '#67f3ff';
const SCREEN_GREEN_BRIGHT = '#63f592';
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
  // UI 面（屏幕/铭牌/终端）按文字优先：线性过滤 + mipmap，远距离与斜视角不糊也不闪。
  // 方块世界的像素风只属于 atlas（office-voxel-atlas），那里仍是 NearestFilter。
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
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
      return { label: '会话', color: SCREEN_CYAN_BRIGHT, bg: '#082230' };
    case 'exited':
      return { label: '已退出', color: SCREEN_EXITED_BRIGHT, bg: '#131c2b' };
  }
}

/** 绘制固定深色像素背景，保证屏幕文本高对比可读。 */
function paintScreenBackdrop(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = '#070c16';
  ctx.fillRect(0, 0, SCREEN_W, SCREEN_H);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.025)';
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
    const offSignature = `off|${palette.mode}|${isSelected ? '1' : '0'}`;
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
    palette.mode,
    isSelected ? '1' : '0',
    session.shortLabel,
    session.availability,
    displayCwd,
    session.provider,
    session.harness || '',
    session.model || '',
  ].join('|');

  if (bundle.lastSignature === signature) {
    return false;
  }
  bundle.lastSignature = signature;

  const { ctx } = bundle;
  ctx.clearRect(0, 0, SCREEN_W, SCREEN_H);

  // 绘制 1024×640 固定屏幕背景
  paintScreenBackdrop(ctx);

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

  // 3. 底部 Provider / Model 信息面板
  const statY = 416;
  const statH = 200;
  const statGap = 22;
  const statW = Math.floor((SCREEN_W - 40 - statGap) / 2);

  drawPixelPanel(ctx, 20, statY, statW, statH, SCREEN_PANEL_BG, '#486f9e', '#03060c', 4);
  ctx.font = `700 30px ${PIXEL_FONT_STACK}`;
  ctx.fillStyle = SCREEN_TEXT_LABEL;
  ctx.fillText('PROVIDER', 46, statY + 46);
  ctx.font = `700 44px ${PIXEL_FONT_STACK}`;
  ctx.fillStyle = SCREEN_CYAN_BRIGHT;
  ctx.fillText(truncateToWidth(ctx, session.provider || session.harness || '—', statW - 52), 46, statY + 132);

  const rightStatX = 20 + statW + statGap;
  drawPixelPanel(ctx, rightStatX, statY, statW, statH, SCREEN_PANEL_BG, '#486f9e', '#03060c', 4);
  ctx.font = `700 30px ${PIXEL_FONT_STACK}`;
  ctx.fillStyle = SCREEN_TEXT_LABEL;
  ctx.fillText('MODEL', rightStatX + 26, statY + 46);
  ctx.font = `700 40px ${PIXEL_FONT_STACK}`;
  ctx.fillStyle = SCREEN_TEXT_BRIGHT;
  ctx.fillText(truncateToWidth(ctx, session.model || '—', statW - 52), rightStatX + 26, statY + 132);

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
    state.isFallbackRoom ? '通用工区' : formatCompactPath(state.projectPath),
  ].filter(Boolean);

  ctx.font = `700 24px ${PIXEL_FONT_STACK}`;
  ctx.fillStyle = '#e0d3bd';
  ctx.fillText(truncateToWidth(ctx, subParts.join(' · '), 686), 40, 174);

  bundle.texture.needsUpdate = true;
  return true;
}

/** 房间终端贴墙方块屏幕（紧凑高对比像素面板，适合 ≤ 2×1 体素贴墙尺寸） */
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
    String(state.totalSessionCount),
    String(state.runningCount),
    String(state.sessions.filter((session) => session.availability === 'exited').length),
  ].join('|');
  if (bundle.lastSignature === sig) return false;
  bundle.lastSignature = sig;

  const { ctx } = bundle;
  const frameColor = palette.accentHex;
  const panelBg = palette.mode === 'light' ? '#1c2b42' : '#142033';
  const rowBg = palette.mode === 'light' ? '#253854' : '#1d2d47';
  drawPixelPanel(ctx, 0, 0, 448, 304, panelBg, frameColor, '#0b1220', 8);

  ctx.textBaseline = 'middle';
  ctx.font = `700 24px ${PIXEL_FONT_STACK}`;
  ctx.fillStyle = frameColor;
  ctx.fillText('ROOM TERMINAL', 26, 40);

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

  const exited = state.sessions.filter((session) => session.availability === 'exited').length;
  drawStat('工位', String(state.totalSessionCount), 72, '#ffffff');
  drawStat('运行', String(state.runningCount), 134, state.runningCount > 0 ? palette.successHex : '#ffffff');
  drawStat('已退', String(exited), 196, exited > 0 ? palette.warningHex : '#ffffff');

  ctx.font = `700 20px ${PIXEL_FONT_STACK}`;
  ctx.fillStyle = palette.accentHex;
  ctx.fillText('项目办公室运行终端', 26, 274);

  bundle.texture.needsUpdate = true;
  return true;
}
