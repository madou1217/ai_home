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
  MONITOR_TEXTURE_HEIGHT,
  MONITOR_TEXTURE_WIDTH,
} from './office-computer-wallpapers';

/**
 * 像素风 2D Canvas 纹理生成器（显示器实时会话预览、墙面铭牌、房间终端、桌面工位牌）。
 * 所有贴图严格启用 NearestFilter、禁用 mipmap、SRGBColorSpace，移除圆角与模糊渐变，
 * 采用高对比深底亮字与 >= 16px 等宽/中文字体保证可读性。
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

const SCREEN_W = MONITOR_TEXTURE_WIDTH;
const SCREEN_H = MONITOR_TEXTURE_HEIGHT;

const DEFAULT_SCREEN_OPTIONS: MonitorScreenTextureOptions = {
  power: 'on',
  wallpaper: 'aurora',
  monitorIndex: 0,
  dualMonitor: false,
  rasterVersion: 0,
};

const PIXEL_FONT_STACK = '"JetBrains Mono", "PingFang SC", "Microsoft YaHei", monospace';

function createPixelCanvasBundle(
  width: number,
  height: number,
  _anisotropy: number
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
  availability: SessionAvailability,
  palette: OfficeScenePalette
): { label: string; color: string; bg: string } {
  switch (availability) {
    case 'interactive':
      return { label: '运行中', color: palette.successHex, bg: '#103020' };
    case 'directory-only':
      return { label: '目录在线', color: palette.accentHex, bg: '#0e2d3b' };
    case 'unavailable':
      return { label: '标识保留', color: palette.warningHex, bg: '#38290d' };
    case 'exited':
      return { label: '已退出', color: palette.screenMutedHex, bg: '#1e2736' };
  }
}

function resolveScreenPreview(session: OfficeSessionItem): {
  kind: 'preview' | 'mail' | 'meta';
  tag: string;
  text: string;
  subline: string;
} {
  const contentPreview = (session.contentPreview || '').trim();
  const latestSnippet = (session.activity.latestSnippet || '').trim();
  const identityLine = session.nativeSessionId || session.sessionKey;
  const compactPath = formatCompactPath(session.cwd);

  if (contentPreview) {
    return {
      kind: 'preview',
      tag: 'LIVE PREVIEW',
      text: contentPreview,
      subline: compactPath || identityLine,
    };
  }
  if (latestSnippet) {
    return {
      kind: 'mail',
      tag: 'PEER MAIL',
      text: latestSnippet,
      subline: compactPath || identityLine,
    };
  }
  return {
    kind: 'meta',
    tag: session.availability === 'unavailable'
      ? 'PRESERVED ID'
      : session.source === 'native'
        ? 'NATIVE SESSION'
        : 'WEB SHELL',
    text: compactPath || '未登记工作目录',
    subline: identityLine,
  };
}

function getActivityLabel(session: OfficeSessionItem): string {
  const { activity, inboxCount, sentCount } = session;
  switch (activity.kind) {
    case 'incoming':
      return `收件 ${inboxCount}`;
    case 'outgoing':
      return `发件 ${sentCount}`;
    case 'both':
      return `收${inboxCount} / 发${sentCount}`;
    case 'idle':
      if (inboxCount > 0 || sentCount > 0) {
        return `MAIL ${inboxCount}/${sentCount}`;
      }
      return session.source === 'native' ? 'NATIVE IDLE' : 'SHELL READY';
  }
}

function resolveWallpaperMetadata(wallpaperId: OfficeWallpaperId) {
  return wallpaperId === 'sunset' || wallpaperId === 'midnight' || wallpaperId === 'aurora'
    ? OFFICE_WALLPAPER_META[wallpaperId]
    : OFFICE_WALLPAPER_META.aurora;
}

/** 绘制低分辨率像素化壁纸背景，保留真实壁纸配色与光栅订阅语义 */
function paintPixelatedWallpaper(
  ctx: CanvasRenderingContext2D,
  wallpaperId: OfficeWallpaperId
): void {
  drawMonitorWallpaperBackdrop(ctx, wallpaperId, SCREEN_W, SCREEN_H);
  // 叠加硬边深色像素遮罩提升前景文字对比度
  ctx.fillStyle = 'rgba(8, 13, 24, 0.34)';
  ctx.fillRect(0, 0, SCREEN_W, SCREEN_H);
  // 像素网格扫描点缀
  ctx.fillStyle = 'rgba(0, 0, 0, 0.14)';
  for (let y = 0; y < SCREEN_H; y += 8) {
    ctx.fillRect(0, y, SCREEN_W, 2);
  }
}

function renderPoweredOffScreen(
  ctx: CanvasRenderingContext2D,
  isSelected: boolean,
  palette: OfficeScenePalette
): void {
  ctx.fillStyle = '#0c1018';
  ctx.fillRect(0, 0, SCREEN_W, SCREEN_H);

  // 像素棋盘暗纹
  ctx.fillStyle = '#111724';
  for (let y = 16; y < SCREEN_H - 16; y += 32) {
    for (let x = 16; x < SCREEN_W - 16; x += 32) {
      ctx.fillRect(x, y, 16, 16);
    }
  }

  // 外框像素边框
  ctx.strokeStyle = isSelected ? palette.accentHex : '#2d3b52';
  ctx.lineWidth = isSelected ? 4 : 2;
  ctx.strokeRect(8, 8, SCREEN_W - 16, SCREEN_H - 16);

  // 像素风格电源方块图标（全矩形，无圆弧）
  const cx = Math.floor(SCREEN_W / 2);
  const cy = Math.floor(SCREEN_H / 2) - 18;
  ctx.fillStyle = isSelected ? palette.accentHex : '#5d728f';
  ctx.fillRect(cx - 20, cy - 12, 6, 32);
  ctx.fillRect(cx + 14, cy - 12, 6, 32);
  ctx.fillRect(cx - 20, cy + 14, 40, 6);
  ctx.fillRect(cx - 3, cy - 22, 6, 22);

  ctx.font = `700 18px ${PIXEL_FONT_STACK}`;
  ctx.fillStyle = isSelected ? palette.accentHex : '#8ea5c2';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('POWER OFF · CLICK TO BOOT', SCREEN_W / 2, cy + 52);
  ctx.textAlign = 'left';
}

function renderSecondaryCompanionScreen(
  ctx: CanvasRenderingContext2D,
  session: OfficeSessionItem,
  isSelected: boolean,
  palette: OfficeScenePalette,
  options: MonitorScreenTextureOptions
): void {
  const wpMeta = resolveWallpaperMetadata(options.wallpaper);
  const availBadge = getAvailabilityBadge(session.availability, palette);
  const providerLabel = session.provider || (session.kind === 'shell' ? 'shell' : 'cli');

  // 外边框
  ctx.strokeStyle = isSelected ? palette.accentHex : '#4b6588';
  ctx.lineWidth = 4;
  ctx.strokeRect(6, 6, SCREEN_W - 12, SCREEN_H - 12);

  // 顶栏
  drawPixelPanel(ctx, 10, 10, SCREEN_W - 20, 44, '#0b1220', '#2b4263', '#05080f', 2);
  ctx.font = `700 16px ${PIXEL_FONT_STACK}`;
  ctx.fillStyle = wpMeta.accentHex;
  ctx.textBaseline = 'middle';
  ctx.fillText(`DISPLAY 2 // ${wpMeta.subtitle.toUpperCase()}`, 22, 32);

  ctx.font = `700 16px ${PIXEL_FONT_STACK}`;
  ctx.fillStyle = palette.screenTextHex;
  ctx.textAlign = 'right';
  ctx.fillText(truncateToWidth(ctx, session.shortLabel, 230), SCREEN_W - 22, 32);
  ctx.textAlign = 'left';

  // 下半双信息方块卡片（保留上部壁纸视野）
  const cardY = 148;
  const cardH = 194;
  const leftW = 340;
  const rightX = 368;
  const rightW = SCREEN_W - rightX - 18;

  drawPixelPanel(ctx, 18, cardY, leftW, cardH, 'rgba(9, 15, 28, 0.90)', '#345278', '#060a14', 2);
  ctx.font = `700 16px ${PIXEL_FONT_STACK}`;
  ctx.fillStyle = wpMeta.accentHex;
  ctx.fillText('SESSION IDENTITY', 32, cardY + 26);

  const drawKv = (label: string, val: string, y: number, color: string) => {
    ctx.font = `700 14px ${PIXEL_FONT_STACK}`;
    ctx.fillStyle = palette.screenMutedHex;
    ctx.fillText(label, 32, y);
    ctx.font = `600 16px ${PIXEL_FONT_STACK}`;
    ctx.fillStyle = color;
    ctx.fillText(truncateToWidth(ctx, val, leftW - 94), 98, y);
  };

  drawKv('KEY', session.sessionKey, cardY + 62, palette.screenTextHex);
  drawKv(
    'ID',
    session.nativeSessionId || (session.source === 'web' ? 'Web Shell' : '—'),
    cardY + 96,
    palette.screenTextHex
  );
  drawKv('DIR', formatCompactPath(session.cwd) || '未指定目录', cardY + 130, palette.screenMutedHex);
  drawKv('TYPE', `${providerLabel.toUpperCase()} · ${availBadge.label}`, cardY + 164, availBadge.color);

  drawPixelPanel(ctx, rightX, cardY, rightW, cardH, 'rgba(9, 15, 28, 0.90)', '#345278', '#060a14', 2);
  ctx.font = `700 16px ${PIXEL_FONT_STACK}`;
  ctx.fillStyle = palette.accentHex;
  ctx.fillText('PEER MAILBOX', rightX + 14, cardY + 26);

  const drawStatLine = (label: string, val: string, y: number, color: string) => {
    ctx.font = `600 16px ${PIXEL_FONT_STACK}`;
    ctx.fillStyle = palette.screenMutedHex;
    ctx.fillText(label, rightX + 14, y);
    ctx.font = `700 18px ${PIXEL_FONT_STACK}`;
    ctx.fillStyle = color;
    ctx.textAlign = 'right';
    ctx.fillText(val, rightX + rightW - 14, y);
    ctx.textAlign = 'left';
  };

  drawStatLine('收件', String(session.inboxCount), cardY + 62, palette.screenTextHex);
  drawStatLine('发件', String(session.sentCount), cardY + 96, palette.screenTextHex);
  drawStatLine(
    '待投',
    String(session.pendingCount),
    cardY + 130,
    session.pendingCount > 0 ? palette.warningHex : palette.screenMutedHex
  );
  drawStatLine(
    '跨室',
    String(session.crossProjectCount),
    cardY + 164,
    session.crossProjectCount > 0 ? palette.violetHex : palette.screenMutedHex
  );

  // 底栏
  drawPixelPanel(ctx, 10, 352, SCREEN_W - 20, 38, '#0b1220', '#2b4263', '#05080f', 2);
  ctx.font = `700 16px ${PIXEL_FONT_STACK}`;
  ctx.fillStyle = wpMeta.accentHex;
  ctx.fillText(`壁纸 ${wpMeta.label}`, 22, 371);
  ctx.fillStyle = palette.screenTextHex;
  ctx.textAlign = 'right';
  ctx.fillText(getActivityLabel(session), SCREEN_W - 22, 371);
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
    const offSignature = `off|${palette.mode}|${isSelected ? '1' : '0'}|${options.monitorIndex}`;
    if (bundle.lastSignature === offSignature) {
      return false;
    }
    bundle.lastSignature = offSignature;
    const { ctx } = bundle;
    ctx.clearRect(0, 0, SCREEN_W, SCREEN_H);
    renderPoweredOffScreen(ctx, isSelected, palette);
    bundle.texture.needsUpdate = true;
    return true;
  }

  const modelLabel = (session.previewModel || session.model || '').trim();
  const providerLabel = session.provider || (session.kind === 'shell' ? 'shell' : 'cli');
  const preview = resolveScreenPreview(session);
  const signature = [
    'on',
    options.wallpaper,
    String(options.monitorIndex),
    options.dualMonitor ? '2' : '1',
    String(options.rasterVersion),
    palette.mode,
    isSelected ? '1' : '0',
    session.shortLabel,
    session.availability,
    providerLabel,
    modelLabel,
    session.sessionKey,
    session.nativeSessionId || '',
    session.cwd,
    preview.kind,
    preview.tag,
    preview.text,
    preview.subline,
    String(session.inboxCount),
    String(session.sentCount),
    String(session.pendingCount),
    String(session.activity.failedCount),
    String(session.crossProjectCount),
    session.activity.kind,
    session.activity.recentPulse ? '1' : '0',
  ].join('|');

  if (bundle.lastSignature === signature) {
    return false;
  }
  bundle.lastSignature = signature;

  const { ctx } = bundle;
  ctx.clearRect(0, 0, SCREEN_W, SCREEN_H);

  // 绘制壁纸底图（支持光栅资产热刷新）
  paintPixelatedWallpaper(ctx, options.wallpaper);

  if (options.monitorIndex === 1) {
    renderSecondaryCompanionScreen(ctx, session, isSelected, palette, options);
    bundle.texture.needsUpdate = true;
    return true;
  }

  const wpMeta = resolveWallpaperMetadata(options.wallpaper);
  const availBadge = getAvailabilityBadge(session.availability, palette);

  // 像素外框
  ctx.strokeStyle = isSelected ? palette.accentHex : '#4b6588';
  ctx.lineWidth = isSelected ? 4 : 2;
  ctx.strokeRect(6, 6, SCREEN_W - 12, SCREEN_H - 12);

  // 顶部系统状态条
  drawPixelPanel(ctx, 10, 10, SCREEN_W - 20, 48, '#0b1220', '#314c70', '#05080f', 2);

  // 像素状态方块灯
  ctx.fillStyle = availBadge.color;
  ctx.fillRect(22, 26, 14, 14);

  ctx.textBaseline = 'middle';
  const mailPillText = session.pendingCount > 0
    ? `MAIL ${session.inboxCount}+${session.pendingCount}`
    : `MAIL ${session.inboxCount}`;
  ctx.font = `700 16px ${PIXEL_FONT_STACK}`;
  const mailPillW = Math.max(108, Math.ceil(ctx.measureText(mailPillText).width) + 22);
  const titleMaxW = SCREEN_W - 64 - mailPillW - 24;

  ctx.font = `700 22px ${PIXEL_FONT_STACK}`;
  ctx.fillStyle = palette.screenTextHex;
  ctx.fillText(truncateToWidth(ctx, session.shortLabel, titleMaxW), 46, 34);

  // 右侧邮件像素徽章
  const mailX = SCREEN_W - 20 - mailPillW;
  const hasActiveMail = session.pendingCount > 0 || session.activity.unreadOrDeliveredCount > 0;
  drawPixelPanel(
    ctx,
    mailX,
    18,
    mailPillW,
    32,
    hasActiveMail ? '#103547' : '#141e30',
    hasActiveMail ? palette.accentHex : '#3a5478',
    '#070c14',
    2
  );
  ctx.font = `700 16px ${PIXEL_FONT_STACK}`;
  ctx.fillStyle = hasActiveMail ? palette.accentHex : palette.screenTextHex;
  ctx.textAlign = 'center';
  ctx.fillText(mailPillText, mailX + mailPillW / 2, 35);
  ctx.textAlign = 'left';

  // 中央像素终端主窗口
  const winX = 18;
  const winY = 68;
  const winW = SCREEN_W - 36;
  const winH = 274;
  const winAccent = preview.kind === 'preview'
    ? palette.accentHex
    : preview.kind === 'mail'
      ? palette.violetHex
      : '#4b6588';
  drawPixelPanel(ctx, winX, winY, winW, winH, 'rgba(9, 15, 28, 0.90)', winAccent, '#050912', 2);

  // 标签行（全部硬边矩形）
  let chipX = winX + 14;
  const chipY = winY + 12;
  const chipH = 30;
  const drawChip = (text: string, fg: string, bg: string, border: string, maxW: number) => {
    ctx.font = `700 16px ${PIXEL_FONT_STACK}`;
    const label = truncateToWidth(ctx, text, maxW - 18);
    const w = Math.min(maxW, Math.ceil(ctx.measureText(label).width) + 18);
    if (chipX + w > winX + winW - 14) return;
    drawPixelPanel(ctx, chipX, chipY, w, chipH, bg, border, '#060a14', 2);
    ctx.fillStyle = fg;
    ctx.fillText(label, chipX + 9, chipY + chipH / 2 + 1);
    chipX += w + 8;
  };

  drawChip(providerLabel.toUpperCase(), palette.accentHex, '#0e2c3d', palette.accentHex, 150);
  if (modelLabel) {
    drawChip(modelLabel, palette.screenTextHex, '#182438', '#46648a', 220);
  }
  drawChip(availBadge.label, availBadge.color, availBadge.bg, availBadge.color, 130);

  // 预览类别 + 路径
  const tagY = winY + 62;
  ctx.font = `700 16px ${PIXEL_FONT_STACK}`;
  ctx.fillStyle = winAccent;
  ctx.fillText(preview.tag, winX + 14, tagY);

  if (preview.subline) {
    ctx.font = `600 16px ${PIXEL_FONT_STACK}`;
    ctx.fillStyle = palette.screenMutedHex;
    const tagW = ctx.measureText(preview.tag).width;
    const subMaxW = winW - 44 - tagW;
    if (subMaxW > 80) {
      ctx.textAlign = 'right';
      ctx.fillText(truncateToWidth(ctx, preview.subline, subMaxW), winX + winW - 14, tagY);
      ctx.textAlign = 'left';
    }
  }

  // 分隔线
  ctx.fillStyle = '#2b4263';
  ctx.fillRect(winX + 12, tagY + 16, winW - 24, 2);

  // 会话真实内容正文（清晰 18px 亮字）
  ctx.font = `600 18px ${PIXEL_FONT_STACK}`;
  ctx.fillStyle = session.availability === 'exited' ? palette.screenMutedHex : palette.screenTextHex;
  const bodyLines = wrapCanvasLines(ctx, preview.text, winW - 32, 5);
  let lineY = tagY + 42;
  for (const line of bodyLines) {
    ctx.fillText(line, winX + 16, lineY);
    lineY += 32;
  }

  // 底部任务栏
  drawPixelPanel(ctx, 10, 352, SCREEN_W - 20, 38, '#0b1220', '#314c70', '#05080f', 2);
  ctx.font = `700 16px ${PIXEL_FONT_STACK}`;
  ctx.fillStyle = palette.screenTextHex;
  ctx.fillText(getActivityLabel(session), 22, 371);

  ctx.fillStyle = wpMeta.accentHex;
  ctx.textAlign = 'center';
  ctx.fillText(
    `${wpMeta.label}${options.dualMonitor ? ' · 双屏' : ''}`,
    SCREEN_W / 2,
    371
  );
  ctx.textAlign = 'left';

  if (session.activity.failedCount > 0) {
    ctx.fillStyle = palette.dangerHex;
    ctx.textAlign = 'right';
    ctx.fillText(`失败 ${session.activity.failedCount}`, SCREEN_W - 22, 371);
    ctx.textAlign = 'left';
  } else if (session.crossProjectCount > 0) {
    ctx.fillStyle = palette.violetHex;
    ctx.textAlign = 'right';
    ctx.fillText(`跨室 ${session.crossProjectCount}`, SCREEN_W - 22, 371);
    ctx.textAlign = 'left';
  } else {
    ctx.fillStyle = isSelected ? palette.accentHex : palette.screenMutedHex;
    ctx.textAlign = 'right';
    ctx.fillText(isSelected ? 'ACTIVE' : 'CLICK OPEN', SCREEN_W - 22, 371);
    ctx.textAlign = 'left';
  }

  bundle.texture.needsUpdate = true;
  return true;
}

/** 桌面工位像素铭牌 */
export function createDeskBadgeBundle(anisotropy: number): CanvasTextureBundle {
  return createPixelCanvasBundle(256, 80, anisotropy);
}

export function updateDeskBadgeTexture(
  bundle: CanvasTextureBundle,
  badgeCode: string,
  accentHex: string,
  palette: OfficeScenePalette
): boolean {
  const sig = `${palette.mode}|${badgeCode}|${accentHex}`;
  if (bundle.lastSignature === sig) return false;
  bundle.lastSignature = sig;

  const { ctx } = bundle;
  // 深色橡木告示牌底色 + 像素描边
  drawPixelPanel(ctx, 0, 0, 256, 80, '#2a1c10', '#8c643b', '#170f08', 6);
  ctx.strokeStyle = accentHex;
  ctx.lineWidth = 4;
  ctx.strokeRect(10, 10, 236, 60);

  ctx.font = `700 32px ${PIXEL_FONT_STACK}`;
  ctx.fillStyle = '#fff8e6';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(badgeCode || 'BAY', 128, 42);
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
