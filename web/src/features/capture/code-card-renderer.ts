// 代码美化卡片的 Canvas 渲染器（DOM 依赖仅限 canvas，不做任何 DOM 克隆）。
// 布局由 code-card-layout（纯函数）负责，这里只负责画：背景、标题栏圆点、
// 代码面板圆角、逐 token 文本；字体/配色来自常量与 shiki 主题。

import {
  CODE_CARD_LINE_HEIGHT,
  CODE_CARD_METRICS,
  layoutCodeCard,
  type CodeCardLayout,
  type CodeCardToken
} from './code-card-layout';

export const CODE_CARD_FONT_FAMILY =
  '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace';

/** 导出倍率上限：2x 已足够清晰，再高只会放大 Canvas 内存与编码时间。 */
const MAX_SCALE = 2;

const DOT_COLORS = ['#ff5f57', '#febc2e', '#28c840'] as const;
const DOT_RADIUS = 6;
const DOT_GAP = 8;

export interface RenderCodeCardOptions {
  /** shiki 主题前景色（token 未显式着色时使用）。 */
  fallbackColor?: string;
  /** 代码面板背景（shiki 主题背景色）。 */
  panelColor?: string;
  /** 覆盖导出倍率（默认 devicePixelRatio，上限 2）。 */
  scale?: number;
}

/** 把 token 排版并绘制成画布，返回可直接编码的 canvas。 */
export function renderCodeCard(
  tokens: CodeCardToken[][],
  options: RenderCodeCardOptions = {}
): HTMLCanvasElement {
  if (typeof document === 'undefined') throw new Error('code_card_requires_document');
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) throw new Error('code_card_canvas_unavailable');

  const measurer = createMeasurer(context);
  const layout = layoutCodeCard(tokens, {
    measure: measurer,
    baseColor: options.fallbackColor || CODE_CARD_METRICS.fallbackColor
  });

  const scale = resolveScale(options.scale);
  canvas.width = Math.max(1, Math.round(layout.width * scale));
  canvas.height = Math.max(1, Math.round(layout.height * scale));

  // 调整尺寸会重置上下文状态，缩放必须在 resize 之后设置。
  context.scale(scale, scale);
  drawCard(context, layout, options);
  return canvas;
}

/** 导出用倍率（测试与指定场景可覆盖）。 */
export function resolveCodeCardScale(scale?: number): number {
  return resolveScale(scale);
}

function resolveScale(scale?: number): number {
  const raw = scale ?? (typeof window !== 'undefined' ? window.devicePixelRatio : 1);
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  return Math.min(Math.max(raw, 1), MAX_SCALE);
}

function createMeasurer(context: CanvasRenderingContext2D): (text: string, fontStyle: number) => number {
  const cache = new Map<string, number>();
  return (text, fontStyle) => {
    const key = `${fontStyle}\u0000${text}`;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    context.font = buildFont(fontStyle);
    const width = context.measureText(text).width;
    cache.set(key, width);
    return width;
  };
}

function buildFont(fontStyle: number): string {
  const italic = (fontStyle & 1) !== 0 ? 'italic ' : '';
  const bold = (fontStyle & 2) !== 0 ? '700 ' : '';
  return `${italic}${bold}${CODE_CARD_METRICS.fontSize}px ${CODE_CARD_FONT_FAMILY}`;
}

function drawCard(
  context: CanvasRenderingContext2D,
  layout: CodeCardLayout,
  options: RenderCodeCardOptions
): void {
  const { padding, titleBarHeight, background, radius } = CODE_CARD_METRICS;

  context.fillStyle = background;
  context.fillRect(0, 0, layout.width, layout.height);

  // 代码面板：与旧实现一致——卡片底色 + shiki 主题底色的圆角区域。
  context.fillStyle = options.panelColor || background;
  roundRectPath(context, padding, layout.codeTop, layout.contentWidth, layout.codeHeight, radius);
  context.fill();

  // 标题栏：三个窗口圆点，位置与旧 CSS（12px 圆点、8px 间距、44px 标题栏）一致。
  const dotY = padding + titleBarHeight / 2;
  DOT_COLORS.forEach((color, index) => {
    const cx = padding + DOT_RADIUS + index * (DOT_RADIUS * 2 + DOT_GAP);
    context.beginPath();
    context.arc(cx, dotY, DOT_RADIUS, 0, Math.PI * 2);
    context.fillStyle = color;
    context.fill();
  });

  context.save();
  roundRectPath(context, padding, layout.codeTop, layout.contentWidth, layout.codeHeight, radius);
  context.clip();
  context.textBaseline = 'middle';

  layout.lines.forEach((line, lineIndex) => {
    const y = layout.codeTop + (lineIndex + 0.5) * CODE_CARD_LINE_HEIGHT;
    for (const span of line) {
      context.font = buildFont(span.fontStyle);
      context.fillStyle = span.color;
      context.fillText(span.text, padding + span.x, y);
    }
  });

  context.restore();
}

function roundRectPath(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
): void {
  const r = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + r, y);
  context.arcTo(x + width, y, x + width, y + height, r);
  context.arcTo(x + width, y + height, x, y + height, r);
  context.arcTo(x, y + height, x, y, r);
  context.arcTo(x, y, x + width, y, r);
  context.closePath();
}
