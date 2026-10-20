// DOM 预览抓帧源（FrameSource 的 DOM 预览实现，策略模式的一个具体实现）。
//
// 关键约束：业务<sandbox>里的 iframe 没有 allow-same-origin（防模型生成的
// HTML 逃逸），宿主读不到它的 contentDocument。这里改为**自建一个同源静态
// 克隆 iframe**：sandbox 只给 allow-same-origin、不给 allow-scripts——脚本
// 完全不执行（<script> 被忽略），CSS 正常渲染，DOM/computedStyle 可读，
// modern-screenshot（foreignObject 序列化）因此可用。每次 grab 都是静态
// 快照；需要 JS / Canvas / CSS 动效时由实时画面帧源负责。
//
// 派发侧永远不感知"这是哪一种 surface"，只消费 FrameSource 契约。
// 帧源对外报告的 width/height 是**输出像素尺寸**（CSS 宽高 × scale），
// 与实时抓帧源保持一致，编码层不需要再二次缩放。

import type { FrameSource } from './types';

export interface DomPreviewFrameSourceOptions {
  html: string;
  /** 视口宽度（CSS px），等于生成的画布 CSS 宽。 */
  width: number;
  /** 可选固定视口高度；缺省时按内容自适应（上限 maxContentHeight）。 */
  height?: number;
  /** 栅格化倍率，默认 1（导出图不再按 dpr 盲目放大）。 */
  scale?: number;
  /** 整页高度上限（CSS px），默认 6000。 */
  maxContentHeight?: number;
  /** 单帧像素预算；超出时自动降低 scale，避免长页面把内存打爆。 */
  maxPixels?: number;
  /** 等待首帧稳定（字体/首屏渲染）的额外毫秒。 */
  settleMs?: number;
}

const DEFAULT_MAX_CONTENT_HEIGHT = 6000;
const DEFAULT_MAX_PIXELS = 4_000_000;
/** 内容没有 block 元素占位时给的最小高度，避免拍出空白线。 */
const MIN_CONTENT_HEIGHT = 64;
/** 初始布局视口：让 100vh 页面先按正常桌面高度排版，再测量真实内容高度。 */
const INITIAL_VIEWPORT_HEIGHT = 720;
const LOAD_TIMEOUT_MS = 8000;
const DEFAULT_SETTLE_MS = 180;

export class DomPreviewFrameSource implements FrameSource {
  /** 输出像素宽度（CSS 宽 × scale）。 */
  readonly width: number;
  /** 输出像素高度（CSS 高 × scale）。 */
  readonly height: number;
  private readonly holder: HTMLDivElement;
  private readonly iframe: HTMLIFrameElement;
  private readonly cssWidth: number;
  private readonly cssHeight: number;
  private readonly scale: number;
  private disposed = false;

  private constructor(
    holder: HTMLDivElement,
    iframe: HTMLIFrameElement,
    cssWidth: number,
    cssHeight: number,
    scale: number
  ) {
    this.holder = holder;
    this.iframe = iframe;
    this.cssWidth = cssWidth;
    this.cssHeight = cssHeight;
    this.scale = scale > 0 ? scale : 1;
    this.width = Math.max(1, Math.floor(cssWidth * this.scale));
    this.height = Math.max(1, Math.floor(cssHeight * this.scale));
  }

  /** 创建 iframe、等待加载完毕与内容高度自适应。 */
  static async create(options: DomPreviewFrameSourceOptions): Promise<DomPreviewFrameSource> {
    if (typeof window === 'undefined') throw new Error('dom_capture_requires_window');
    const cssWidth = Math.max(2, Math.round(options.width));
    const maxContentHeight = Math.max(
      MIN_CONTENT_HEIGHT,
      Math.round(options.maxContentHeight ?? DEFAULT_MAX_CONTENT_HEIGHT)
    );
    const requestedScale = options.scale && options.scale > 0 ? options.scale : 1;

    const holder = window.document.createElement('div');
    holder.setAttribute('data-capture-holder', '');
    holder.setAttribute('aria-hidden', 'true');
    holder.style.position = 'fixed';
    holder.style.left = '-10000px';
    holder.style.top = '0';
    holder.style.width = `${cssWidth}px`;
    holder.style.height = '0';
    holder.style.overflow = 'hidden';
    holder.style.opacity = '0';
    holder.style.pointerEvents = 'none';

    const iframe = window.document.createElement('iframe');
    // 关键：同源可读 + 无脚本。allow-same-origin 单独出现时不授予脚本执行。
    iframe.setAttribute('sandbox', 'allow-same-origin');
    iframe.tabIndex = -1;
    iframe.style.width = `${cssWidth}px`;
    iframe.style.height = `${Math.max(
      MIN_CONTENT_HEIGHT,
      options.height ?? INITIAL_VIEWPORT_HEIGHT
    )}px`;
    iframe.style.border = '0';
    iframe.style.display = 'block';
    iframe.style.background = '#ffffff';
    holder.appendChild(iframe);
    window.document.body.appendChild(holder);

    const loaded = new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error('dom_capture_load_timeout')), LOAD_TIMEOUT_MS);
      iframe.addEventListener('load', () => {
        window.clearTimeout(timer);
        resolve();
      }, { once: true });
      iframe.addEventListener('error', () => {
        window.clearTimeout(timer);
        reject(new Error('dom_capture_load_failed'));
      }, { once: true });
    });
    iframe.srcdoc = options.html || '<!doctype html><html><body></body></html>';
    try {
      await loaded;
    } catch (error) {
      holder.remove();
      throw error;
    }

    let cssHeight = Math.max(MIN_CONTENT_HEIGHT, options.height ?? INITIAL_VIEWPORT_HEIGHT);
    const doc = iframe.contentDocument;
    const applyContentHeight = async () => {
      if (!doc || options.height) return false;
      const measured = Math.min(
        maxContentHeight,
        Math.max(MIN_CONTENT_HEIGHT, measureContentHeight(doc))
      );
      if (Math.abs(measured - cssHeight) < 1) return false;
      cssHeight = measured;
      iframe.style.height = `${cssHeight}px`;
      await nextFrame();
      return true;
    };
    if (doc && !options.height) {
      await applyContentHeight();
    }
    const settle = options.settleMs ?? DEFAULT_SETTLE_MS;
    if (settle > 0) {
      await new Promise<void>((resolve) => window.setTimeout(resolve, settle));
      await nextFrame();
      // 字体/图片加载后内容可能变高，再量一次，避免截断尾部。
      await applyContentHeight();
    }

    // 像素预算优先：长页面降低栅格化倍率，但完整保留内容。
    const maxPixels = Math.max(1, options.maxPixels ?? DEFAULT_MAX_PIXELS);
    const budgetScale = Math.sqrt(maxPixels / Math.max(1, cssWidth * cssHeight));
    const scale = Math.max(0.25, Math.min(requestedScale, budgetScale));

    return new DomPreviewFrameSource(holder, iframe, cssWidth, cssHeight, scale);
  }

  /** 重新栅格化当前 DOM 状态为一张画布（每帧独立快照）。 */
  async grab(): Promise<HTMLCanvasElement | null> {
    if (this.disposed) return null;
    const doc = this.iframe.contentDocument;
    const node = doc?.documentElement;
    if (!doc || !node) return null;
    const { domToCanvas } = await import('modern-screenshot');
    const canvas = await domToCanvas(node, {
      scale: this.scale,
      width: this.cssWidth,
      height: this.cssHeight,
      // 克隆文档没有自己的背景设置时给出白底，保证 png 不透明可预览。
      backgroundColor: readBodyBackground(doc) || '#ffffff',
      features: { removeControlCharacter: false }
    });
    return canvas;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.holder.remove();
  }
}

function measureContentHeight(doc: Document): number {
  // 用 body 的 scrollHeight 量内容：documentElement.scrollHeight 至少等于
  // 视口高度，会把短页面强行撑成 720px。body 为空（只有 fixed 内容）时
  // 再退回文档高度。
  const bodyHeight = doc.body?.scrollHeight ?? 0;
  const documentHeight = doc.documentElement?.scrollHeight ?? 0;
  return bodyHeight > 0 ? bodyHeight : documentHeight;
}

function readBodyBackground(doc: Document): string | null {  try {
    const view = doc.defaultView;
    for (const element of [doc.body, doc.documentElement]) {
      if (!element) continue;
      const computed = view?.getComputedStyle(element).backgroundColor;
      if (computed && computed !== 'transparent' && computed !== 'rgba(0, 0, 0, 0)') {
        return computed;
      }
      const inline = element.style?.backgroundColor;
      if (inline && inline !== 'transparent' && inline !== 'rgba(0, 0, 0, 0)') return inline;
    }
    return null;
  } catch {
    return null;
  }
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (window.requestAnimationFrame) {
      window.requestAnimationFrame(() => resolve());
      return;
    }
    window.setTimeout(resolve, 16);
  });
}
