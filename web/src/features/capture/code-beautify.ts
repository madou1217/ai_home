// 代码块美化导出（ray.so 风格）：shiki token → Canvas 直接绘制 → PNG。
//
// 性能约束：合成卡片不走「HTML 克隆 + modern-screenshot」的抓帧管线——
// 那条路径的成本是 O(DOM 节点)，300 行 HTML 的 4 万个高亮 span 实测要 13s。
// 这里按 token 排版后直接 fillText，成本只与 token 数线性相关（约百毫秒级）。
// 布局在 code-card-layout（纯函数），绘制在 code-card-renderer。

import type { StillCaptureFormatId } from './types';
import type { HighlighterCore } from 'shiki/core';
import { normalizeCodeIndent, type CodeCardToken } from './code-card-layout';
import { renderCodeCard } from './code-card-renderer';

/** 预览代码块就是 HTML，固定语言避免整包语言表进入初始 chunk。 */
const HIGHLIGHT_LANG = 'html';
const HIGHLIGHT_THEME = 'github-dark-default';

let highlighterPromise: Promise<HighlighterCore> | null = null;

/** 按需加载 shiki core + 单一语言/主题（不 import 'shiki' 全量包）。 */
async function loadHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    highlighterPromise = (async () => {
      const [core, engine, lang, theme] = await Promise.all([
        import('shiki/core'),
        import('shiki/engine/oniguruma'),
        import('shiki/langs/html.mjs'),
        import('shiki/themes/github-dark-default.mjs')
      ]);
      return core.createHighlighterCore({
        themes: [theme.default],
        langs: [lang.default],
        engine: engine.createOnigurumaEngine(import('shiki/wasm'))
      });
    })().catch((error) => {
      // 首次加载失败（如 chunk 网络错误）时允许下次重试。
      highlighterPromise = null;
      throw error;
    });
  }
  return highlighterPromise;
}

export interface BeautifyExportOptions {
  code: string;
  format?: StillCaptureFormatId;
  /** 导出文件基础名。 */
  baseName?: string;
  /** 分阶段进度（高亮 / 绘制 / 编码），供按钮展示。 */
  onProgress?: (label: string) => void;
}

/**
 * 生成美化截图（ray.so 风格卡片）并返回产物。
 * 保持纯函数语义：不直接 download，由调用方决定落盘动作。
 */
export async function createBeautifiedCapture(options: BeautifyExportOptions): Promise<{
  blob: Blob;
  fileName: string;
}> {
  const { code, format = 'png', baseName = 'code-beautify', onProgress } = options;

  onProgress?.('正在高亮…');
  const highlighter = await loadHighlighter();
  const { tokens, fg, bg } = highlighter.codeToTokens(normalizeCodeIndent(code), {
    lang: HIGHLIGHT_LANG,
    theme: HIGHLIGHT_THEME
  });
  const cardTokens: CodeCardToken[][] = tokens.map((line) =>
    line.map((token) => ({
      content: token.content,
      color: token.color,
      fontStyle: token.fontStyle
    }))
  );

  onProgress?.('正在绘制卡片…');
  const canvas = renderCodeCard(cardTokens, {
    fallbackColor: fg,
    panelColor: bg
  });

  onProgress?.(format === 'png' ? '正在编码 PNG…' : '正在编码图片…');
  const blob = await encodeStillFormat(canvas, format);
  return { blob, fileName: `${baseName}-${Date.now()}.${format}` };
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
