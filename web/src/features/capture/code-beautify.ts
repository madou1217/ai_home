// 代码块美化导出（ray.so 风格）：shiki 高亮 → 内联样式卡片 → modern-screenshot 导出 PNG。
//
// 实现策略：不创建真实 DOM 挂到页面上再截图，而是构造一个独立的 Document，
// 走 DomPreviewFrameSource 同一条栅格化管线（FrameSource 契约复用，编译走
// dom-preview 的实现），因此截图派发仍只有一个入口。

import type { StillCaptureFormatId } from '../types';

/** 卡片视觉常量（ray.so 风格骨架，深色底 + 大圆角 + 内边距）。 */
const CARD_THEME = {
  background: '#0b1120',
  padding: 40,
  radius: 16,
  titleBarHeight: 44,
  fontSize: 15,
  lineHeight: 1.7,
  maxCharsPerLine: 80
} as const;

/** shiki 主题/语言按需加载集合：html/嵌html/js/css 覆盖预览代码块的主要形态。 */
const HIGHLIGHT_LANG = 'html';
const HIGHLIGHT_THEME = 'github-dark-default';

let highlighterPromise: Promise<import('shiki').Highlighter> | null = null;

async function loadHighlighter(): Promise<import('shiki').Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = import('shiki').then((shiki) =>
      shiki.createHighlighter({
        themes: [HIGHLIGHT_THEME],
        langs: [HIGHLIGHT_LANG]
      })
    );
  }
  return highlighterPromise;
}

export interface BeautifyExportOptions {
  code: string;
  /** 可选语言提示；未识别时回退 html（预览块场景代码就是 HTML）。 */
  language?: string;
  format?: StillCaptureFormatId;
  /** 导出文件基础名。 */
  baseName?: string;
}

/**
 * 生成美化截图（ray.so 风格卡片）并返回产物。
 * 保持纯函数语义：不直接 download，由调用方决定落盘动作。
 */
export async function createBeautifiedCapture(options: BeautifyExportOptions): Promise<{
  blob: Blob;
  fileName: string;
}> {
  const { code, format = 'png', baseName = 'code-beautify' } = options;
  const highlighter = await loadHighlighter();
  const html = highlighter.codeToHtml(normalizeCodeIndent(code), {
    lang: HIGHLIGHT_LANG,
    theme: HIGHLIGHT_THEME
  });
  const width = measureViewportWidth(code);
  const doc = buildBeautifyDocument(html, width);
  const canvas = await rasterizeDocument(doc, width);
  const blob = await encodeStillFormat(canvas, format);
  return { blob, fileName: `${baseName}-${Date.now()}.${format === 'png' ? 'png' : format}` };
}

/** 统一去公共缩进，避免整段代码被一层缩进推宽。 */
function normalizeCodeIndent(code: string): string {
  const lines = code.replace(/\t/g, '  ').split('\n');
  const indents = lines
    .filter((line) => line.trim().length > 0)
    .map((line) => (line.match(/^ +/)?.[0].length ?? 0));
  const common = indents.length > 0 ? Math.min(...indents) : 0;
  return lines.map((line) => line.slice(common)).join('\n').trim();
}

/** 视口宽度按最长行估算（等宽字体、像素级近似）。 */
function measureViewportWidth(code: string): number {
  const longest = Math.max(
    CARD_TITLE_WIDTH_SCALE,
    ...normalizeCodeIndent(code)
      .split('\n')
      .map((line) => line.length)
  );
  const clamped = Math.min(longest, CARD_MAX_CHARS);
  return CARD_PADDING * 2 + CODE_FONT_WIDTH * clamped;
}

const CARD_TITLE_WIDTH_SCALE = 24;
const CARD_MAX_CHARS = 96;
const CARD_PADDING = 40;
const CODE_FONT_WIDTH = 9;

function buildBeautifyDocument(shikiHtml: string, width: number): string {
  const { background, padding, radius, titleBarHeight, fontSize, lineHeight } = CARD_THEME;
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    width: ${width}px;
    background: ${background};
    padding: ${padding}px;
    font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
  }
  .titlebar {
    height: ${titleBarHeight}px;
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
  }
  .dot { width: 12px; height: 12px; border-radius: 50%; }
  .dot-1 { background: #ff5f57; }
  .dot-2 { background: #febc2e; }
  .dot-3 { background: #28c840; }
  pre {
    padding: 0;
    border-radius: ${radius}px;
    font-size: ${fontSize}px;
    line-height: ${lineHeight};
    overflow: hidden;
  }
  code { font-family: inherit; }
</style>
</head>
<body>
  <div class="titlebar">
    <span class="dot dot-1"></span><span class="dot dot-2"></span><span class="dot dot-3"></span>
  </div>
  ${shikiHtml}
</body>
</html>`;
}

/** 复用 DOM 栅格化管线（与预览截图同一 FrameSource 实现）。 */
async function rasterizeDocument(docHtml: string, width: number): Promise<HTMLCanvasElement> {
  const { DomPreviewFrameSource } = await import('./dom-preview-frame-source');
  const source = await DomPreviewFrameSource.create({ html: docHtml, width });
  try {
    const canvas = await source.grab();
    if (!canvas) throw new Error('beautify_rasterize_failed');
    return canvas as HTMLCanvasElement;
  } finally {
    source.dispose();
  }
}

async function encodeStillFormat(
  canvas: HTMLCanvasElement,
  format: StillCaptureFormatId
): Promise<Blob> {
  if (format === 'jpeg') return canvasToBlob(canvas, 'image/jpeg', 0.92);
  if (format === 'webp') return canvasToBlob(canvas, 'image/webp', 0.92);
  // still 域仅 png/jpeg/webp 三种，剩余即 png。
  return canvasToBlob(canvas, 'image/png');
}

function canvasToBlob(canvas: HTMLCanvasElement, mimeType: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('beautify_encode_empty'))),
      mimeType,
      quality
    );
  });
}
