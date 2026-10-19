// DOM 预览抓帧源（FrameSource 的 DOM 预览实现，策略模式的一个具体实现）。
//
// 关键约束：业务<sandbox>里的 iframe 没有 allow-same-origin（防模型生成的
// HTML 逃逸），宿主读不到它的 contentDocument。这里改为**自建一个同源静态
// 克隆 iframe**：sandbox 只给 allow-same-origin、不给 allow-scripts——脚本
// 完全不执行（<script> 被忽略），CSS 正常渲染，DOM/computedStyle 可读，
// modern-screenshot（foreignObject 序列化）因此可用。录制"所见动画"指
// CSS 动画（跑马灯/呼吸等）；JS 驱动的内容只截到初始 hydration 图。
//
// 派发侧永远不感知"这是哪一种 surface"，只消费 FrameSource 契约。

import type { FrameSource } from './types';

export interface DomPreviewFrameSourceOptions {
  html: string;
  /** 视口宽度（CSS px），等于生成的画布 CSS 宽。 */
  width: number;
  /** 可选固定视口高度；缺省时按内容自适应（上限 MAX_CONTENT_HEIGHT）。 */
  height?: number;
  /** 栅格化倍率，默认跟 UI 一倍即可（导出图会按 dpr 放大）。 */
  scale?: number;
  /** 等待首帧稳定（字体/首屏渲染）的额外毫秒。 */
  settleMs?: number;
}

const MAX_CONTENT_HEIGHT = 3000;
/** 内容没有 block 元素占位时给的最小高度，避免拍出空白线。 */
const MIN_CONTENT_HEIGHT = 64;
const LOAD_TIMEOUT_MS = 8000;
const DEFAULT_SETTLE_MS = 180;

export class DomPreviewFrameSource implements FrameSource {
  readonly width: number;
  readonly height: number;
  private readonly holder: HTMLDivElement;
  private readonly iframe: HTMLIFrameElement;
  private readonly scale: number;
  private disposed = false;

  private constructor(
    holder: HTMLDivElement,
    iframe: HTMLIFrameElement,
    width: number,
    height: number,
    scale: number
  ) {
    this.holder = holder;
    this.iframe = iframe;
    this.width = width;
    this.height = height;
    this.scale = scale > 0 ? scale : 1;
  }

  /** 创建 iframe、等待加载完毕与内容高度自适应。 */
  static async create(options: DomPreviewFrameSourceOptions): Promise<DomPreviewFrameSource> {
    if (typeof window === 'undefined') throw new Error('dom_capture_requires_window');
    const width = Math.max(2, Math.round(options.width));
    const scale = options.scale && options.scale > 0 ? options.scale : window.devicePixelRatio || 1;

    const holder = window.document.createElement('div');
    holder.setAttribute('data-capture-holder', '');
    holder.setAttribute('aria-hidden', 'true');
    holder.style.position = 'fixed';
    holder.style.left = '-10000px';
    holder.style.top = '0';
    holder.style.width = `${width}px`;
    holder.style.height = '0';
    holder.style.overflow = 'hidden';
    holder.style.opacity = '0';
    holder.style.pointerEvents = 'none';

    const iframe = window.document.createElement('iframe');
    // 关键：同源可读 + 无脚本。allow-same-origin 单独出现时不授予脚本执行。
    iframe.setAttribute('sandbox', 'allow-same-origin');
    iframe.tabIndex = -1;
    iframe.style.width = `${width}px`;
    iframe.style.height = `${Math.max(MIN_CONTENT_HEIGHT, options.height ?? MIN_CONTENT_HEIGHT)}px`;
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

    let height = Math.max(MIN_CONTENT_HEIGHT, options.height ?? MIN_CONTENT_HEIGHT);
    const doc = iframe.contentDocument;
    if (doc && !options.height) {
      const scrollHeight = Math.max(
        doc.documentElement?.scrollHeight ?? 0,
        doc.body?.scrollHeight ?? 0
      );
      height = Math.min(MAX_CONTENT_HEIGHT, Math.max(MIN_CONTENT_HEIGHT, scrollHeight));
      iframe.style.height = `${height}px`;
      // 高度变化后等一帧让样式重排完成。
      await nextFrame();
    }
    const settle = options.settleMs ?? DEFAULT_SETTLE_MS;
    if (settle > 0) {
      await new Promise<void>((resolve) => window.setTimeout(resolve, settle));
      await nextFrame();
    }

    const source = new DomPreviewFrameSource(holder, iframe, width, height, scale);
    return source;
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
      width: this.width,
      height: this.height,
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

function readBodyBackground(doc: Document): string | null {
  try {
    const inline = doc.body?.style?.backgroundColor;
    if (inline && inline !== 'transparent' && inline !== 'rgba(0, 0, 0, 0)') return inline;
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
