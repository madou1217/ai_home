import * as THREE from 'three';
import type { OfficeSessionItem, SessionAvailability } from './session-office-types';
import type { OfficeScenePalette, OfficeSceneSyncState } from './office-scene-types';
import type { VoxelQualityTier } from './office-voxel-atlas';

/**
 * 高可读性 2D Canvas 显示器与建筑铭牌纹理生成器：
 * - 支持双档距离 LOD（standard 常规视角 / closeup 近距阅读最高 2048×1280），
 *   采用统一逻辑画布坐标（1024×640）等比矢量缩放，LOD 切换零排版跳变、近距字体锐利如真屏。
 * - 严格启用 LinearMipmapLinearFilter + LinearFilter + SRGBColorSpace + 最高硬件各向异性（最高 16x）。
 * - 高对比深黑曜石屏底（#060b14）与亮白/高饱和语义文字，满足 WCAG AAA >= 8:1 对比度，
 *   配合显示器无光照洗白的 MeshBasicMaterial(toneMapped: false) 彻底消除光晕过曝。
 */

export type MonitorScreenLod = 'standard' | 'closeup';

export interface CanvasTextureBundle {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  texture: THREE.CanvasTexture;
  lastSignature: string;
  lod?: MonitorScreenLod;
}

export const OFFICE_MONITOR_CANVAS_WIDTH = 1024;
export const OFFICE_MONITOR_CANVAS_HEIGHT = 640;

const LOGICAL_W = 1024;
const LOGICAL_H = 640;

const UI_FONT_STACK = '"JetBrains Mono", "Fira Code", "Consolas", "PingFang SC", "Microsoft YaHei", monospace';

// 高对比深曜石配色（WCAG AAA >= 8:1）
const SCREEN_BG = '#060b14';
const SCREEN_HEADER_BG = '#0a1220';
const SCREEN_CARD_BG = '#0c1628';
const SCREEN_CARD_ALT_BG = '#09111f';
const SCREEN_BORDER_BASE = '#2d4769';
const SCREEN_BORDER_ACTIVE = '#4de8ff';
const SCREEN_DIVIDER = '#1c314d';
const SCREEN_TEXT_BRIGHT = '#f4f8ff';
const SCREEN_TEXT_BODY = '#dce9fa';
const SCREEN_TEXT_LABEL = '#8fb0d4';
const SCREEN_TEXT_DIM = '#6d8aab';
const SCREEN_CYAN = '#56ecff';
const SCREEN_GREEN = '#58f08a';
const SCREEN_AMBER = '#ffc94d';
const SCREEN_EXITED = '#b6c7dc';

export function resolveMonitorLodDimensions(
  lod: MonitorScreenLod,
  tier: VoxelQualityTier = 'high'
): { width: number; height: number } {
  if (lod === 'closeup') {
    if (tier === 'high') return { width: 2048, height: 1280 };
    if (tier === 'medium') return { width: 1536, height: 960 };
    return { width: 1024, height: 640 };
  }
  if (tier === 'low') return { width: 768, height: 480 };
  return { width: 1024, height: 640 };
}

function clampAnisotropy(anisotropy: number): number {
  return Math.max(4, Math.min(16, Math.floor(anisotropy || 4)));
}

function createUiCanvasBundle(
  width: number,
  height: number,
  anisotropy: number,
  lod?: MonitorScreenLod
): CanvasTextureBundle {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('2D canvas context unavailable for 3D scene textures');
  }
  ctx.imageSmoothingEnabled = true;

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = clampAnisotropy(anisotropy);

  return {
    canvas,
    ctx,
    texture,
    lastSignature: '',
    lod,
  };
}

/** 按目标分辨率原地升级/降级显示器画布尺寸，并重置纹理（零材质重建） */
export function resizeMonitorScreenBundle(
  bundle: CanvasTextureBundle,
  lod: MonitorScreenLod,
  tier: VoxelQualityTier,
  anisotropy: number
): boolean {
  const { width, height } = resolveMonitorLodDimensions(lod, tier);
  const nextAniso = clampAnisotropy(anisotropy);
  const sizeChanged = bundle.canvas.width !== width || bundle.canvas.height !== height;
  const lodChanged = bundle.lod !== lod;
  bundle.lod = lod;
  bundle.texture.anisotropy = nextAniso;

  if (!sizeChanged && !lodChanged) {
    return false;
  }

  if (sizeChanged) {
    bundle.canvas.width = width;
    bundle.canvas.height = height;
    // Canvas 尺寸变更后释放旧 GPU 纹理存储并触发重新分配上传
    bundle.texture.dispose();
  }
  bundle.lastSignature = '';
  return true;
}

/** 绘制 Minecraft 风格硬边清晰像素框（统一 1~2px 完整外框，无粗左侧装饰条） */
function drawCrispPanel(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  fill: string,
  borderTopLeft: string,
  borderBottomRight: string,
  borderPx = 2
): void {
  ctx.fillStyle = fill;
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = borderTopLeft;
  ctx.fillRect(x, y, w, borderPx);
  ctx.fillRect(x, y, borderPx, h);
  ctx.fillStyle = borderBottomRight;
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

function formatCompactPath(cwd: string, maxChars = 44): string {
  const trimmed = cwd.trim();
  if (!trimmed || trimmed === '__no_cwd__') return '';
  if (trimmed.length <= maxChars) return trimmed;
  const parts = trimmed.split('/').filter(Boolean);
  if (parts.length <= 3) return trimmed;
  return `…/${parts.slice(-3).join('/')}`;
}

function getAvailabilityBadge(
  availability: SessionAvailability
): { label: string; color: string; bg: string; border: string } {
  switch (availability) {
    case 'interactive':
      return { label: '运行中', color: SCREEN_GREEN, bg: '#092415', border: '#2ecc71' };
    case 'directory-only':
      return { label: '目录在线', color: SCREEN_CYAN, bg: '#07212e', border: '#38bdf8' };
    case 'unavailable':
      return { label: '会话在线', color: SCREEN_AMBER, bg: '#261b07', border: '#f59e0b' };
    case 'exited':
      return { label: '已退出', color: SCREEN_EXITED, bg: '#131d2d', border: '#475569' };
  }
}

function paintScreenBackdrop(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = SCREEN_BG;
  ctx.fillRect(0, 0, LOGICAL_W, LOGICAL_H);
  // 极淡像素点阵纹理，不降低正文对比度
  ctx.fillStyle = 'rgba(130, 175, 225, 0.024)';
  for (let y = 0; y < LOGICAL_H; y += 8) {
    ctx.fillRect(0, y, LOGICAL_W, 1);
  }
}

export function createMonitorScreenBundle(
  anisotropy: number,
  lod: MonitorScreenLod = 'standard',
  tier: VoxelQualityTier = 'high'
): CanvasTextureBundle {
  const { width, height } = resolveMonitorLodDimensions(lod, tier);
  return createUiCanvasBundle(width, height, anisotropy, lod);
}

export function updateMonitorScreenTexture(
  bundle: CanvasTextureBundle,
  session: OfficeSessionItem,
  isSelected: boolean,
  palette: OfficeScenePalette,
  lodOverride?: MonitorScreenLod
): boolean {
  const lod = lodOverride ?? bundle.lod ?? 'standard';
  const isCloseup = lod === 'closeup';
  const previewText = (session.contentPreview || '').trim();
  const displayCwd = formatCompactPath(session.cwd, isCloseup ? 64 : 42) || '未登记工作目录';
  const resolvedProvider = session.provider || session.harness || (session.kind === 'shell' ? 'shell' : 'cli');
  const resolvedModel = session.previewModel || session.model || '—';
  const resolvedTitle = isCloseup ? (session.label || session.shortLabel) : session.shortLabel;
  const badgeCode = session.persona.badgeCode || 'BAY';
  const identityHint = session.nativeSessionId || session.sessionKey;

  const signature = [
    'screen-v4',
    `${bundle.canvas.width}x${bundle.canvas.height}`,
    lod,
    palette.mode,
    isSelected ? '1' : '0',
    badgeCode,
    resolvedTitle,
    session.availability,
    session.source,
    displayCwd,
    resolvedProvider,
    resolvedModel,
    previewText.slice(0, 220),
    isCloseup ? identityHint : '',
  ].join('|');

  if (bundle.lastSignature === signature) {
    return false;
  }
  bundle.lastSignature = signature;

  const { ctx, canvas } = bundle;
  const scale = canvas.width / LOGICAL_W;
  ctx.save();
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.clearRect(0, 0, LOGICAL_W, LOGICAL_H);

  paintScreenBackdrop(ctx);

  const avail = getAvailabilityBadge(session.availability);
  const frameBorder = isSelected ? SCREEN_BORDER_ACTIVE : SCREEN_BORDER_BASE;

  // 外边框
  ctx.strokeStyle = frameBorder;
  ctx.lineWidth = isSelected ? 4 : 3;
  ctx.strokeRect(6, 6, LOGICAL_W - 12, LOGICAL_H - 12);

  // === 1. 顶部会话标题栏（y: 18..126） ===
  drawCrispPanel(
    ctx,
    18,
    18,
    LOGICAL_W - 36,
    108,
    SCREEN_HEADER_BG,
    isSelected ? SCREEN_BORDER_ACTIVE : '#35567e',
    '#04070e',
    3
  );
  ctx.textBaseline = 'middle';

  // 状态方块灯
  ctx.fillStyle = avail.color;
  ctx.fillRect(36, 61, 18, 18);

  // 工位编号微徽章（如 S01）
  ctx.font = `700 22px ${UI_FONT_STACK}`;
  const badgeW = Math.max(76, Math.ceil(ctx.measureText(badgeCode).width) + 24);
  drawCrispPanel(ctx, 68, 46, badgeW, 48, '#102138', '#3c6799', '#050b14', 2);
  ctx.fillStyle = SCREEN_CYAN;
  ctx.textAlign = 'center';
  ctx.fillText(badgeCode, 68 + badgeW * 0.5, 71);
  ctx.textAlign = 'left';

  // 右侧状态徽章 + 来源标签
  ctx.font = `700 26px ${UI_FONT_STACK}`;
  const statusPillW = Math.max(156, Math.ceil(ctx.measureText(avail.label).width) + 38);
  const statusPillX = LOGICAL_W - 34 - statusPillW;
  drawCrispPanel(ctx, statusPillX, 42, statusPillW, 58, avail.bg, avail.border, '#04080f', 2);
  ctx.fillStyle = avail.color;
  ctx.textAlign = 'center';
  ctx.fillText(avail.label, statusPillX + statusPillW * 0.5, 72);
  ctx.textAlign = 'left';

  let titleRightEdge = statusPillX - 18;
  if (isCloseup) {
    const sourceTag = session.source === 'native' ? 'CLI' : 'WEB';
    ctx.font = `700 20px ${UI_FONT_STACK}`;
    const srcW = 68;
    const srcX = statusPillX - srcW - 12;
    drawCrispPanel(ctx, srcX, 48, srcW, 46, '#101c2e', '#3a577d', '#050912', 2);
    ctx.fillStyle = SCREEN_TEXT_LABEL;
    ctx.textAlign = 'center';
    ctx.fillText(sourceTag, srcX + srcW * 0.5, 72);
    ctx.textAlign = 'left';
    titleRightEdge = srcX - 16;
  }

  // 会话主标题（近距/常规均大号清晰，深底亮白高对比）
  const titleX = 68 + badgeW + 18;
  const titleMaxW = Math.max(160, titleRightEdge - titleX);
  ctx.font = `700 ${isCloseup ? 38 : 44}px ${UI_FONT_STACK}`;
  ctx.fillStyle = SCREEN_TEXT_BRIGHT;
  ctx.fillText(truncateToWidth(ctx, resolvedTitle, titleMaxW), titleX, 72);

  // === 2. 中部核心内容卡（y: 142..430）：有预览时展示实时预览 + 路径条；无预览时展示大号工作目录 + 会话标识 ===
  const midY = 142;
  const midH = isCloseup ? 276 : 292;
  drawCrispPanel(ctx, 18, midY, LOGICAL_W - 36, midH, SCREEN_CARD_BG, '#34557c', '#040811', 3);

  if (previewText) {
    // 顶部预览标签行
    ctx.font = `700 22px ${UI_FONT_STACK}`;
    ctx.fillStyle = SCREEN_CYAN;
    ctx.fillText('SESSION PREVIEW', 40, midY + 30);

    // 右侧紧凑目录摘要
    ctx.font = `600 20px ${UI_FONT_STACK}`;
    ctx.fillStyle = SCREEN_TEXT_LABEL;
    ctx.textAlign = 'right';
    ctx.fillText(truncateToWidth(ctx, displayCwd, 560), LOGICAL_W - 40, midY + 30);
    ctx.textAlign = 'left';

    ctx.fillStyle = SCREEN_DIVIDER;
    ctx.fillRect(36, midY + 52, LOGICAL_W - 72, 2);

    // 终端摘要正文（近距显示最多 4 行 28px 锐利字；远距显示最多 3 行 34px 易读字）
    const bodyFontPx = isCloseup ? 28 : 34;
    const lineStep = isCloseup ? 44 : 54;
    const maxLines = isCloseup ? 4 : 3;
    ctx.font = `600 ${bodyFontPx}px ${UI_FONT_STACK}`;
    ctx.fillStyle = session.availability === 'exited' ? SCREEN_EXITED : SCREEN_TEXT_BODY;
    const wrapped = wrapCanvasLines(ctx, previewText, LOGICAL_W - 104, maxLines);
    let textY = midY + (isCloseup ? 88 : 96);
    for (let i = 0; i < wrapped.length; i += 1) {
      if (i === 0) {
        ctx.fillStyle = SCREEN_GREEN;
        ctx.fillText('>', 40, textY);
        ctx.fillStyle = session.availability === 'exited' ? SCREEN_EXITED : SCREEN_TEXT_BRIGHT;
        ctx.fillText(wrapped[i], 66, textY);
      } else {
        ctx.fillStyle = session.availability === 'exited' ? SCREEN_EXITED : SCREEN_TEXT_BODY;
        ctx.fillText(wrapped[i], 66, textY);
      }
      textY += lineStep;
    }
  } else {
    // 无预览内容时展示清晰大号 WORKDIR + SESSION ID
    ctx.font = `700 24px ${UI_FONT_STACK}`;
    ctx.fillStyle = SCREEN_CYAN;
    ctx.fillText('WORKDIR', 40, midY + 34);

    ctx.fillStyle = SCREEN_DIVIDER;
    ctx.fillRect(36, midY + 58, LOGICAL_W - 72, 2);

    ctx.font = `700 ${isCloseup ? 34 : 38}px ${UI_FONT_STACK}`;
    ctx.fillStyle = session.availability === 'exited' ? SCREEN_EXITED : SCREEN_TEXT_BRIGHT;
    const cwdLines = wrapCanvasLines(ctx, displayCwd, LOGICAL_W - 84, 2);
    let lineY = midY + 106;
    for (const line of cwdLines) {
      ctx.fillText(line, 40, lineY);
      lineY += 52;
    }

    // 底部附加 Session ID 行，避免卡片空白
    drawCrispPanel(
      ctx,
      36,
      midY + midH - 64,
      LOGICAL_W - 72,
      46,
      SCREEN_CARD_ALT_BG,
      '#243c5c',
      '#04070e',
      2
    );
    ctx.font = `700 19px ${UI_FONT_STACK}`;
    ctx.fillStyle = SCREEN_TEXT_LABEL;
    ctx.fillText('ID', 52, midY + midH - 40);
    ctx.font = `600 21px ${UI_FONT_STACK}`;
    ctx.fillStyle = SCREEN_TEXT_BODY;
    ctx.fillText(truncateToWidth(ctx, identityHint, LOGICAL_W - 156), 92, midY + midH - 40);
  }

  // === 3. 底部 Provider / Model 结构化面板 ===
  const statY = midY + midH + 16;
  const footerReserve = isCloseup ? 44 : 18;
  const statH = LOGICAL_H - statY - footerReserve;
  const statGap = 18;
  const statW = Math.floor((LOGICAL_W - 36 - statGap) / 2);

  drawCrispPanel(ctx, 18, statY, statW, statH, SCREEN_CARD_BG, '#34557c', '#040811', 3);
  ctx.font = `700 22px ${UI_FONT_STACK}`;
  ctx.fillStyle = SCREEN_TEXT_LABEL;
  ctx.fillText('PROVIDER', 40, statY + 34);
  ctx.font = `700 ${isCloseup ? 36 : 42}px ${UI_FONT_STACK}`;
  ctx.fillStyle = SCREEN_CYAN;
  ctx.fillText(truncateToWidth(ctx, resolvedProvider, statW - 44), 40, statY + statH * 0.66);

  const rightStatX = 18 + statW + statGap;
  drawCrispPanel(ctx, rightStatX, statY, statW, statH, SCREEN_CARD_BG, '#34557c', '#040811', 3);
  ctx.font = `700 22px ${UI_FONT_STACK}`;
  ctx.fillStyle = SCREEN_TEXT_LABEL;
  ctx.fillText('MODEL', rightStatX + 22, statY + 34);
  ctx.font = `700 ${isCloseup ? 32 : 36}px ${UI_FONT_STACK}`;
  ctx.fillStyle = SCREEN_TEXT_BRIGHT;
  ctx.fillText(truncateToWidth(ctx, resolvedModel, statW - 44), rightStatX + 22, statY + statH * 0.66);

  // 近距阅读模式底部精简状态提示栏
  if (isCloseup) {
    ctx.font = `600 17px ${UI_FONT_STACK}`;
    ctx.fillStyle = SCREEN_TEXT_DIM;
    ctx.fillText('CLICK SCREEN TO OPEN DESKTOP', 24, LOGICAL_H - 22);
    ctx.textAlign = 'right';
    ctx.fillText('DRAG MONITOR TO ROTATE', LOGICAL_W - 24, LOGICAL_H - 22);
    ctx.textAlign = 'left';
  }

  ctx.restore();
  bundle.texture.needsUpdate = true;
  return true;
}

/** 桌面工位橡木铭牌（512×160 高清铭牌） */
export function createDeskBadgeBundle(anisotropy: number): CanvasTextureBundle {
  return createUiCanvasBundle(512, 160, anisotropy);
}

export function updateDeskBadgeTexture(
  bundle: CanvasTextureBundle,
  badgeCode: string,
  accentHex: string,
  palette: OfficeScenePalette
): boolean {
  const sig = `badge-v4|${palette.mode}|${badgeCode}|${accentHex}`;
  if (bundle.lastSignature === sig) return false;
  bundle.lastSignature = sig;

  const { ctx } = bundle;
  drawCrispPanel(ctx, 0, 0, 512, 160, '#23160b', '#946a3f', '#120a05', 10);
  ctx.strokeStyle = accentHex;
  ctx.lineWidth = 6;
  ctx.strokeRect(18, 18, 476, 124);

  // 四角黄铜铆钉
  ctx.fillStyle = '#f2c94c';
  ctx.fillRect(28, 28, 10, 10);
  ctx.fillRect(474, 28, 10, 10);
  ctx.fillRect(28, 122, 10, 10);
  ctx.fillRect(474, 122, 10, 10);

  ctx.font = `700 64px ${UI_FONT_STACK}`;
  ctx.fillStyle = '#fff9ec';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(truncateToWidth(ctx, badgeCode || 'BAY', 410), 256, 82);
  ctx.textAlign = 'left';

  bundle.texture.needsUpdate = true;
  return true;
}

/** 墙面项目房间铭牌（1024×288 高清橡木金铆告示牌） */
export function createWallPlaqueBundle(anisotropy: number): CanvasTextureBundle {
  return createUiCanvasBundle(1024, 288, anisotropy);
}

export function updateWallPlaqueTexture(
  bundle: CanvasTextureBundle,
  state: OfficeSceneSyncState,
  palette: OfficeScenePalette
): boolean {
  const sig = [
    'plaque-v4',
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
  const bgFill = palette.mode === 'light' ? '#332418' : '#211811';
  const rimLight = palette.mode === 'light' ? '#b0824f' : '#856039';
  drawCrispPanel(ctx, 0, 0, 1024, 288, bgFill, rimLight, '#120c07', 10);
  ctx.strokeStyle = palette.accentHex;
  ctx.lineWidth = 4;
  ctx.strokeRect(16, 16, 992, 256);

  // 四角金块铆钉
  ctx.fillStyle = '#f5cc2c';
  ctx.fillRect(28, 28, 14, 14);
  ctx.fillRect(982, 28, 14, 14);
  ctx.fillRect(28, 246, 14, 14);
  ctx.fillRect(982, 246, 14, 14);

  ctx.textBaseline = 'middle';
  ctx.font = `700 28px ${UI_FONT_STACK}`;
  ctx.fillStyle = palette.accentHex;
  ctx.fillText('PROJECT ROOM', 56, 62);

  ctx.font = `700 62px ${UI_FONT_STACK}`;
  ctx.fillStyle = '#fff9ed';
  ctx.fillText(truncateToWidth(ctx, state.roomName.toUpperCase(), 912), 56, 144);

  const subParts = [
    `${state.totalSessionCount} 工位`,
    `${state.runningCount} 运行`,
    state.isFallbackRoom ? '通用工区' : formatCompactPath(state.projectPath, 44),
  ].filter(Boolean);

  ctx.font = `700 30px ${UI_FONT_STACK}`;
  ctx.fillStyle = '#e5d6be';
  ctx.fillText(truncateToWidth(ctx, subParts.join(' · '), 912), 56, 224);

  bundle.texture.needsUpdate = true;
  return true;
}

/** 房间终端贴墙方块屏幕（640×448 高对比面板） */
export function createRoomTerminalBundle(anisotropy: number): CanvasTextureBundle {
  return createUiCanvasBundle(640, 448, anisotropy);
}

export function updateRoomTerminalTexture(
  bundle: CanvasTextureBundle,
  state: OfficeSceneSyncState,
  palette: OfficeScenePalette
): boolean {
  const exited = state.sessions.filter((session) => session.availability === 'exited').length;
  const sig = [
    'term-v4',
    palette.mode,
    String(state.totalSessionCount),
    String(state.runningCount),
    String(exited),
  ].join('|');
  if (bundle.lastSignature === sig) return false;
  bundle.lastSignature = sig;

  const { ctx } = bundle;
  const frameColor = palette.accentHex;
  drawCrispPanel(ctx, 0, 0, 640, 448, '#0b1424', frameColor, '#050912', 10);

  ctx.textBaseline = 'middle';
  ctx.font = `700 30px ${UI_FONT_STACK}`;
  ctx.fillStyle = frameColor;
  ctx.fillText('ROOM TERMINAL', 34, 52);

  const drawStat = (label: string, val: string, y: number, color: string) => {
    drawCrispPanel(ctx, 32, y, 576, 82, '#132238', '#3c618a', '#060c17', 3);

    ctx.font = `700 30px ${UI_FONT_STACK}`;
    ctx.fillStyle = '#dceaff';
    ctx.fillText(label, 54, y + 42);

    ctx.font = `700 44px ${UI_FONT_STACK}`;
    ctx.fillStyle = color;
    ctx.textAlign = 'right';
    ctx.fillText(val, 582, y + 42);
    ctx.textAlign = 'left';
  };

  drawStat('工位总数', String(state.totalSessionCount), 92, '#ffffff');
  drawStat('运行会话', String(state.runningCount), 188, state.runningCount > 0 ? SCREEN_GREEN : '#ffffff');
  drawStat('已退会话', String(exited), 284, exited > 0 ? SCREEN_AMBER : '#ffffff');

  ctx.font = `700 24px ${UI_FONT_STACK}`;
  ctx.fillStyle = SCREEN_TEXT_LABEL;
  ctx.fillText('项目办公室状态监视屏', 34, 404);

  bundle.texture.needsUpdate = true;
  return true;
}
