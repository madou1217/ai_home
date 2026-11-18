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

function createCanvasBundle(
  width: number,
  height: number,
  anisotropy: number,
  repeat = false
): CanvasTextureBundle {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('2D canvas context unavailable for 3D scene textures');
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = Math.min(8, Math.max(1, anisotropy));
  if (repeat) {
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
  } else {
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
  }
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  return {
    canvas,
    ctx,
    texture,
    lastSignature: '',
  };
}

function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
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
            lines[maxLines - 1] = truncateToWidth(ctx, `${lines[maxLines - 1]} ${remaining.trim()}`, maxWidth);
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
  if (trimmed.length <= 44) return trimmed;
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
      return { label: '运行中', color: palette.successHex, bg: 'rgba(18, 235, 116, 0.14)' };
    case 'directory-only':
      return { label: '目录在线', color: palette.accentHex, bg: 'rgba(0, 229, 255, 0.14)' };
    case 'unavailable':
      return { label: '标识保留', color: palette.warningHex, bg: 'rgba(255, 170, 29, 0.16)' };
    case 'exited':
      return { label: '已退出', color: palette.screenMutedHex, bg: 'rgba(132, 162, 188, 0.14)' };
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
      return `↙ 收件 ${inboxCount}`;
    case 'outgoing':
      return `↗ 发件 ${sentCount}`;
    case 'both':
      return `⇄ 收${inboxCount} / 发${sentCount}`;
    case 'idle':
      if (inboxCount > 0 || sentCount > 0) {
        return `MAIL ${inboxCount}/${sentCount}`;
      }
      return session.source === 'native' ? 'NATIVE IDLE' : 'SHELL READY';
  }
}

export function createMonitorScreenBundle(anisotropy: number): CanvasTextureBundle {
  return createCanvasBundle(SCREEN_W, SCREEN_H, anisotropy, false);
}

function renderPoweredOffScreen(
  ctx: CanvasRenderingContext2D,
  isSelected: boolean,
  palette: OfficeScenePalette
): void {
  const darkGrad = ctx.createLinearGradient(0, 0, SCREEN_W, SCREEN_H);
  darkGrad.addColorStop(0, '#04060a');
  darkGrad.addColorStop(0.55, '#070b12');
  darkGrad.addColorStop(1, '#030508');
  ctx.fillStyle = darkGrad;
  ctx.fillRect(0, 0, SCREEN_W, SCREEN_H);

  // Subtle dark glass reflection sweep (no preview or wallpaper shown)
  ctx.save();
  ctx.fillStyle = 'rgba(148, 175, 205, 0.035)';
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(SCREEN_W * 0.48, 0);
  ctx.lineTo(SCREEN_W * 0.22, SCREEN_H);
  ctx.lineTo(0, SCREEN_H);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // Subtle standby border highlight when station is selected
  ctx.strokeStyle = isSelected ? palette.accentHex : 'rgba(60, 82, 108, 0.28)';
  ctx.lineWidth = isSelected ? 2 : 1;
  ctx.strokeRect(8, 8, SCREEN_W - 16, SCREEN_H - 16);

  // Small muted standby ring at center-bottom
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.22)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(SCREEN_W / 2, SCREEN_H / 2, 16, -Math.PI * 0.3, Math.PI * 1.3);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(SCREEN_W / 2, SCREEN_H / 2 - 20);
  ctx.lineTo(SCREEN_W / 2, SCREEN_H / 2 - 4);
  ctx.stroke();

  ctx.font = '600 13px "JetBrains Mono", "PingFang SC", monospace';
  ctx.fillStyle = isSelected ? palette.accentHex : 'rgba(148, 163, 184, 0.45)';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('POWER OFF · CLICK TO BOOT', SCREEN_W / 2, SCREEN_H / 2 + 34);
  ctx.textAlign = 'left';
}

function resolveWallpaperMetadata(wallpaperId: OfficeWallpaperId) {
  return wallpaperId === 'sunset' || wallpaperId === 'midnight' || wallpaperId === 'aurora'
    ? OFFICE_WALLPAPER_META[wallpaperId]
    : OFFICE_WALLPAPER_META.aurora;
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

  // Outer highlight frame
  ctx.strokeStyle = isSelected ? palette.accentHex : 'rgba(255, 255, 255, 0.16)';
  ctx.lineWidth = isSelected ? 3 : 1.5;
  ctx.strokeRect(8, 8, SCREEN_W - 16, SCREEN_H - 16);

  // Top translucent OS bar
  ctx.fillStyle = 'rgba(5, 11, 20, 0.72)';
  ctx.fillRect(10, 10, SCREEN_W - 20, 40);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.10)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(10, 50);
  ctx.lineTo(SCREEN_W - 10, 50);
  ctx.stroke();

  ctx.font = '700 13px "JetBrains Mono", monospace';
  ctx.fillStyle = wpMeta.accentHex;
  ctx.textBaseline = 'middle';
  ctx.fillText(`DISPLAY 2 // ${wpMeta.subtitle.toUpperCase()}`, 22, 30);

  ctx.font = '600 13px "JetBrains Mono", "PingFang SC", monospace';
  ctx.fillStyle = palette.screenTextHex;
  ctx.textAlign = 'right';
  ctx.fillText(truncateToWidth(ctx, session.shortLabel, 240), SCREEN_W - 22, 30);
  ctx.textAlign = 'left';

  // Keep upper-middle band open so the wallpaper shows through clearly,
  // and render two crisp bottom translucent workspace HUD widgets with real session data.
  const cardY = 176;
  const cardH = 166;
  const leftW = 330;
  const rightX = 368;
  const rightW = SCREEN_W - rightX - 22;

  // Left Card: Session Identity & Directory
  drawRoundedRect(ctx, 22, cardY, leftW, cardH, 6);
  ctx.fillStyle = 'rgba(5, 11, 20, 0.76)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.font = '700 12px "JetBrains Mono", monospace';
  ctx.fillStyle = wpMeta.accentHex;
  ctx.fillText('SESSION IDENTITY', 36, cardY + 22);

  const drawKv = (label: string, val: string, y: number, color: string) => {
    ctx.font = '600 11px "JetBrains Mono", monospace';
    ctx.fillStyle = palette.screenMutedHex;
    ctx.fillText(label, 36, y);
    ctx.font = '500 13px "JetBrains Mono", "PingFang SC", monospace';
    ctx.fillStyle = color;
    ctx.fillText(truncateToWidth(ctx, val, leftW - 92), 104, y);
  };

  drawKv('KEY', session.sessionKey, cardY + 52, palette.screenTextHex);
  drawKv(
    'ID',
    session.nativeSessionId || (session.source === 'web' ? 'Web Shell' : '—'),
    cardY + 80,
    palette.screenTextHex
  );
  drawKv('DIR', formatCompactPath(session.cwd) || '未指定目录', cardY + 108, palette.screenMutedHex);
  drawKv(
    'TYPE',
    `${providerLabel.toUpperCase()} · ${availBadge.label}`,
    cardY + 136,
    availBadge.color
  );

  // Right Card: Mail & Sync Counters
  drawRoundedRect(ctx, rightX, cardY, rightW, cardH, 6);
  ctx.fillStyle = 'rgba(5, 11, 20, 0.76)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
  ctx.stroke();

  ctx.font = '700 12px "JetBrains Mono", monospace';
  ctx.fillStyle = palette.accentHex;
  ctx.fillText('PEER MAILBOX', rightX + 14, cardY + 22);

  const drawStatLine = (label: string, val: string, y: number, color: string) => {
    ctx.font = '500 13px "JetBrains Mono", "PingFang SC", monospace';
    ctx.fillStyle = palette.screenMutedHex;
    ctx.fillText(label, rightX + 14, y);
    ctx.font = '700 15px "JetBrains Mono", monospace';
    ctx.fillStyle = color;
    ctx.textAlign = 'right';
    ctx.fillText(val, rightX + rightW - 14, y);
    ctx.textAlign = 'left';
  };

  drawStatLine('收件 INBOX', String(session.inboxCount), cardY + 54, palette.screenTextHex);
  drawStatLine('发件 SENT', String(session.sentCount), cardY + 82, palette.screenTextHex);
  drawStatLine(
    '待投 PENDING',
    String(session.pendingCount),
    cardY + 110,
    session.pendingCount > 0 ? palette.warningHex : palette.screenMutedHex
  );
  drawStatLine(
    '跨室 CROSS',
    String(session.crossProjectCount),
    cardY + 138,
    session.crossProjectCount > 0 ? palette.violetHex : palette.screenMutedHex
  );

  // Bottom translucent dock strip
  ctx.fillStyle = 'rgba(5, 11, 20, 0.72)';
  ctx.fillRect(10, 356, SCREEN_W - 20, 34);
  ctx.font = '600 12px "JetBrains Mono", "PingFang SC", monospace';
  ctx.fillStyle = wpMeta.accentHex;
  ctx.fillText(`壁纸 ${wpMeta.label}`, 22, 373);
  ctx.fillStyle = palette.screenMutedHex;
  ctx.textAlign = 'right';
  ctx.fillText(getActivityLabel(session), SCREEN_W - 22, 373);
  ctx.textAlign = 'left';
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

  // Paint selected wallpaper across entire screen so wallpaper colors show clearly in 3D
  drawMonitorWallpaperBackdrop(ctx, options.wallpaper, SCREEN_W, SCREEN_H);

  if (options.monitorIndex === 1) {
    renderSecondaryCompanionScreen(ctx, session, isSelected, palette, options);
    bundle.texture.needsUpdate = true;
    return true;
  }

  const wpMeta = resolveWallpaperMetadata(options.wallpaper);

  // Outer 1px frame
  const availBadge = getAvailabilityBadge(session.availability, palette);
  const borderColor = isSelected ? palette.accentHex : 'rgba(255, 255, 255, 0.18)';
  ctx.strokeStyle = borderColor;
  ctx.lineWidth = isSelected ? 3 : 2;
  ctx.strokeRect(8, 8, SCREEN_W - 16, SCREEN_H - 16);

  // Top Header Bar (frosted dark glass letting wallpaper glow behind)
  ctx.fillStyle = 'rgba(6, 13, 24, 0.74)';
  ctx.fillRect(10, 10, SCREEN_W - 20, 48);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(10, 58);
  ctx.lineTo(SCREEN_W - 10, 58);
  ctx.stroke();

  // Status LED circle
  ctx.fillStyle = availBadge.color;
  ctx.beginPath();
  ctx.arc(30, 34, 6.5, 0, Math.PI * 2);
  ctx.fill();

  // Session short label
  ctx.textBaseline = 'middle';
  const mailPillText = session.pendingCount > 0
    ? `MAIL ${session.inboxCount} +${session.pendingCount}`
    : `MAIL ${session.inboxCount}`;
  ctx.font = '600 15px "JetBrains Mono", monospace';
  const mailPillW = Math.max(92, ctx.measureText(mailPillText).width + 22);
  const titleMaxW = SCREEN_W - 60 - mailPillW - 26;
  ctx.font = '600 20px "JetBrains Mono", "PingFang SC", "Microsoft YaHei", monospace';
  const titleText = truncateToWidth(ctx, session.shortLabel, titleMaxW);
  ctx.fillStyle = palette.screenTextHex;
  ctx.fillText(titleText, 48, 35);

  // Right Mail Pill
  const mailX = SCREEN_W - 20 - mailPillW;
  const hasActiveMail = session.pendingCount > 0 || session.activity.unreadOrDeliveredCount > 0;
  drawRoundedRect(ctx, mailX, 18, mailPillW, 32, 4);
  ctx.fillStyle = hasActiveMail ? 'rgba(0, 229, 255, 0.18)' : 'rgba(255, 255, 255, 0.06)';
  ctx.fill();
  ctx.strokeStyle = hasActiveMail ? palette.accentHex : palette.screenBorderHex;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.font = '600 14px "JetBrains Mono", monospace';
  ctx.fillStyle = hasActiveMail ? palette.accentHex : palette.screenMutedHex;
  ctx.textAlign = 'center';
  ctx.fillText(mailPillText, mailX + mailPillW / 2, 35);
  ctx.textAlign = 'left';

  // Floating Desktop Window Frame (inset over wallpaper so wallpaper perimeter & horizon stay visible)
  const winX = 24;
  const winY = 74;
  const winW = SCREEN_W - 48;
  const winH = 266;
  drawRoundedRect(ctx, winX, winY, winW, winH, 8);
  ctx.fillStyle = 'rgba(6, 13, 24, 0.78)';
  ctx.fill();
  ctx.strokeStyle = preview.kind === 'preview'
    ? 'rgba(0, 229, 255, 0.36)'
    : preview.kind === 'mail'
      ? 'rgba(168, 85, 247, 0.42)'
      : 'rgba(255, 255, 255, 0.16)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Metadata Chips Row inside floating desktop window (y = 84..112)
  let chipX = winX + 14;
  const chipY = winY + 12;
  const chipH = 28;
  const drawChip = (text: string, fg: string, bg: string, border: string, maxW: number) => {
    ctx.font = '600 13px "JetBrains Mono", "PingFang SC", monospace';
    const label = truncateToWidth(ctx, text, maxW - 18);
    const w = Math.min(maxW, ctx.measureText(label).width + 18);
    if (chipX + w > winX + winW - 14) return;
    drawRoundedRect(ctx, chipX, chipY, w, chipH, 4);
    ctx.fillStyle = bg;
    ctx.fill();
    ctx.strokeStyle = border;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = fg;
    ctx.fillText(label, chipX + 9, chipY + chipH / 2 + 1);
    chipX += w + 8;
  };

  drawChip(providerLabel.toUpperCase(), palette.accentHex, 'rgba(0, 229, 255, 0.12)', 'rgba(0, 229, 255, 0.38)', 130);
  if (modelLabel) {
    drawChip(modelLabel, palette.screenTextHex, 'rgba(255, 255, 255, 0.08)', palette.screenBorderHex, 210);
  }
  drawChip(availBadge.label, availBadge.color, availBadge.bg, availBadge.color, 120);

  // Preview Tag Badge + Subline
  const tagY = winY + 58;
  const tagColor = preview.kind === 'preview'
    ? palette.accentHex
    : preview.kind === 'mail'
      ? palette.violetHex
      : palette.screenMutedHex;
  ctx.font = '700 12px "JetBrains Mono", monospace';
  ctx.fillStyle = tagColor;
  ctx.fillText(preview.tag, winX + 16, tagY);

  if (preview.subline) {
    ctx.font = '400 12px "JetBrains Mono", monospace';
    ctx.fillStyle = palette.screenMutedHex;
    const tagW = ctx.measureText(preview.tag).width;
    const subMaxW = winW - 48 - tagW;
    if (subMaxW > 60) {
      const subText = truncateToWidth(ctx, preview.subline, subMaxW);
      ctx.textAlign = 'right';
      ctx.fillText(subText, winX + winW - 16, tagY);
      ctx.textAlign = 'left';
    }
  }

  // Divider below tag
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.10)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(winX + 14, tagY + 14);
  ctx.lineTo(winX + winW - 14, tagY + 14);
  ctx.stroke();

  // Real bounded preview text lines
  ctx.font = preview.kind === 'meta'
    ? '500 17px "JetBrains Mono", "PingFang SC", monospace'
    : '400 18px "JetBrains Mono", "PingFang SC", "Microsoft YaHei", monospace';
  ctx.fillStyle = session.availability === 'exited' ? palette.screenMutedHex : palette.screenTextHex;
  const bodyLines = wrapCanvasLines(ctx, preview.text, winW - 34, 5);
  let lineY = tagY + 38;
  for (const line of bodyLines) {
    ctx.fillText(line, winX + 16, lineY);
    lineY += 28;
  }

  // Bottom Translucent Taskbar (y = 352..390)
  ctx.fillStyle = 'rgba(6, 13, 24, 0.76)';
  ctx.fillRect(10, 352, SCREEN_W - 20, 38);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
  ctx.beginPath();
  ctx.moveTo(10, 352);
  ctx.lineTo(SCREEN_W - 10, 352);
  ctx.stroke();

  ctx.font = '600 13px "JetBrains Mono", "PingFang SC", monospace';
  ctx.fillStyle = palette.screenMutedHex;
  const activityLabel = getActivityLabel(session);
  ctx.fillText(activityLabel, 22, 372);

  // Subtle wallpaper tag at center of taskbar
  ctx.fillStyle = wpMeta.accentHex;
  ctx.textAlign = 'center';
  ctx.fillText(
    `${wpMeta.label}${options.dualMonitor ? ' · 双屏' : ''}`,
    SCREEN_W / 2,
    372
  );
  ctx.textAlign = 'left';

  if (session.activity.failedCount > 0) {
    ctx.fillStyle = palette.dangerHex;
    ctx.textAlign = 'right';
    ctx.fillText(`失败 ${session.activity.failedCount}`, SCREEN_W - 22, 372);
    ctx.textAlign = 'left';
  } else if (session.crossProjectCount > 0) {
    ctx.fillStyle = palette.violetHex;
    ctx.textAlign = 'right';
    ctx.fillText(`跨室协作 ${session.crossProjectCount}`, SCREEN_W - 22, 372);
    ctx.textAlign = 'left';
  } else {
    ctx.fillStyle = isSelected ? palette.accentHex : palette.screenMutedHex;
    ctx.textAlign = 'right';
    ctx.fillText(isSelected ? 'ACTIVE STATION' : 'CLICK MONITOR', SCREEN_W - 22, 372);
    ctx.textAlign = 'left';
  }

  bundle.texture.needsUpdate = true;
  return true;
}

export function createFloorTileBundle(anisotropy: number): CanvasTextureBundle {
  return createCanvasBundle(512, 512, anisotropy, true);
}

export function updateFloorTileTexture(
  bundle: CanvasTextureBundle,
  palette: OfficeScenePalette
): boolean {
  const sig = `${palette.mode}|${palette.floorBaseHex}|${palette.floorGridHex}`;
  if (bundle.lastSignature === sig) return false;
  bundle.lastSignature = sig;

  const { ctx } = bundle;
  ctx.fillStyle = palette.floorBaseHex;
  ctx.fillRect(0, 0, 512, 512);

  // Subtle architectural tile seams
  ctx.strokeStyle = palette.floorGridHex;
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, 510, 510);

  ctx.lineWidth = 1;
  ctx.globalAlpha = 0.55;
  for (let i = 128; i < 512; i += 128) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i, 512);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, i);
    ctx.lineTo(512, i);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // Subtle corner ticks
  ctx.fillStyle = palette.accentHex;
  ctx.globalAlpha = palette.mode === 'dark' ? 0.25 : 0.18;
  ctx.fillRect(0, 0, 10, 3);
  ctx.fillRect(0, 0, 3, 10);
  ctx.globalAlpha = 1;

  bundle.texture.needsUpdate = true;
  return true;
}

export function createWindowSkyBundle(anisotropy: number): CanvasTextureBundle {
  return createCanvasBundle(512, 256, anisotropy, false);
}

export function updateWindowSkyTexture(
  bundle: CanvasTextureBundle,
  palette: OfficeScenePalette
): boolean {
  const sig = `${palette.mode}|${palette.windowSkyTopHex}|${palette.windowSkyBottomHex}`;
  if (bundle.lastSignature === sig) return false;
  bundle.lastSignature = sig;

  const { ctx } = bundle;
  const grad = ctx.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, palette.windowSkyTopHex);
  grad.addColorStop(1, palette.windowSkyBottomHex);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 512, 256);

  // Subtle architectural skyline silhouette
  ctx.fillStyle = palette.mode === 'dark' ? 'rgba(6, 12, 22, 0.52)' : 'rgba(130, 165, 198, 0.35)';
  const towers = [
    [12, 130, 44, 126],
    [62, 96, 52, 160],
    [124, 142, 38, 114],
    [172, 82, 58, 174],
    [244, 118, 48, 138],
    [304, 72, 62, 184],
    [378, 110, 50, 146],
    [438, 92, 60, 164],
  ];
  for (const [x, y, w, h] of towers) {
    ctx.fillRect(x, y, w, h);
  }

  // Horizon light band
  const glow = ctx.createLinearGradient(0, 170, 0, 256);
  glow.addColorStop(0, 'rgba(0, 229, 255, 0)');
  glow.addColorStop(1, palette.mode === 'dark' ? 'rgba(0, 229, 255, 0.16)' : 'rgba(255, 255, 255, 0.45)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 170, 512, 86);

  bundle.texture.needsUpdate = true;
  return true;
}

export function createDeskBadgeBundle(anisotropy: number): CanvasTextureBundle {
  return createCanvasBundle(192, 64, anisotropy, false);
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
  ctx.fillStyle = palette.screenBgHex;
  ctx.fillRect(0, 0, 192, 64);

  ctx.strokeStyle = accentHex;
  ctx.lineWidth = 3;
  ctx.strokeRect(4, 4, 184, 56);

  ctx.font = '700 24px "JetBrains Mono", monospace';
  ctx.fillStyle = palette.screenTextHex;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(badgeCode || 'BAY', 96, 33);
  ctx.textAlign = 'left';

  bundle.texture.needsUpdate = true;
  return true;
}

export function createWallPlaqueBundle(anisotropy: number): CanvasTextureBundle {
  return createCanvasBundle(768, 192, anisotropy, false);
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
  ctx.fillStyle = palette.screenBgHex;
  ctx.fillRect(0, 0, 768, 192);

  ctx.strokeStyle = palette.accentHex;
  ctx.lineWidth = 3;
  ctx.strokeRect(6, 6, 756, 180);

  ctx.font = '700 18px "JetBrains Mono", monospace';
  ctx.fillStyle = palette.accentHex;
  ctx.textBaseline = 'middle';
  ctx.fillText('SECTOR // PROJECT ROOM', 30, 38);

  ctx.font = '700 38px "Orbitron", "JetBrains Mono", "PingFang SC", sans-serif';
  ctx.fillStyle = palette.screenTextHex;
  ctx.fillText(truncateToWidth(ctx, state.roomName.toUpperCase(), 700), 30, 92);

  const subParts = [
    `${state.totalSessionCount} 工位`,
    `${state.runningCount} 活跃`,
    state.crossProjectMailCount > 0 ? `跨室联络 ${state.crossProjectMailCount}` : '',
    state.isFallbackRoom ? '通用工区' : formatCompactPath(state.projectPath),
  ].filter(Boolean);

  ctx.font = '500 18px "JetBrains Mono", "PingFang SC", monospace';
  ctx.fillStyle = palette.screenMutedHex;
  ctx.fillText(truncateToWidth(ctx, subParts.join(' · '), 708), 30, 146);

  bundle.texture.needsUpdate = true;
  return true;
}

export function createRoomTerminalBundle(anisotropy: number): CanvasTextureBundle {
  return createCanvasBundle(384, 256, anisotropy, false);
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
  ctx.fillStyle = palette.screenBgHex;
  ctx.fillRect(0, 0, 384, 256);

  ctx.strokeStyle = state.hasRecentPulse ? palette.successHex : palette.accentHex;
  ctx.lineWidth = 3;
  ctx.strokeRect(8, 8, 368, 240);

  ctx.font = '700 18px "JetBrains Mono", monospace';
  ctx.fillStyle = palette.accentHex;
  ctx.textBaseline = 'middle';
  ctx.fillText('ROOM MAIL TERMINAL', 24, 38);

  ctx.fillStyle = state.hasRecentPulse ? palette.successHex : palette.accentHex;
  ctx.beginPath();
  ctx.arc(348, 38, 8, 0, Math.PI * 2);
  ctx.fill();

  const drawStat = (label: string, val: string, y: number, color: string) => {
    drawRoundedRect(ctx, 24, y, 336, 44, 5);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.04)';
    ctx.fill();
    ctx.strokeStyle = palette.screenBorderHex;
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.font = '500 17px "JetBrains Mono", "PingFang SC", monospace';
    ctx.fillStyle = palette.screenMutedHex;
    ctx.fillText(label, 40, y + 23);

    ctx.font = '700 22px "JetBrains Mono", monospace';
    ctx.fillStyle = color;
    ctx.textAlign = 'right';
    ctx.fillText(val, 344, y + 23);
    ctx.textAlign = 'left';
  };

  drawStat('房间邮件总计', String(state.roomMessageCount), 66, palette.screenTextHex);
  drawStat('待投递队列', String(state.pendingMailCount), 120, state.pendingMailCount > 0 ? palette.warningHex : palette.screenTextHex);
  drawStat('跨项目协作', String(state.crossProjectMailCount), 174, state.crossProjectMailCount > 0 ? palette.violetHex : palette.screenTextHex);

  ctx.font = '600 13px "JetBrains Mono", "PingFang SC", monospace';
  ctx.fillStyle = palette.accentHex;
  ctx.fillText('点击终端打开房间协作邮箱', 24, 232);

  bundle.texture.needsUpdate = true;
  return true;
}
