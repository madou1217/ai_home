// 独立预览弹窗的实时抓帧源（宿主侧）。
//
// 弹窗自己在用户点击时调用 getDisplayMedia（保留用户手势），把屏幕共享流挂到
// 弹窗文档里的隐藏 <video> 上，然后通过 postMessage 通知宿主。宿主与弹窗同源，
// 因此可以直接读取该 video 的当前帧并裁切到预览区域——脚本、Canvas/WebGL、
// 滚动和旋转都会被真实录制，不再依赖不执行脚本的静态 HTML 克隆。

import type { FrameSource } from './types';
import { computeDisplayCrop } from './live-preview-frame-source';

export const CAPTURE_VIDEO_ID = 'aih-capture-video';
export const CAPTURE_TARGET_ID = 'aih-preview-target';
const MAX_WIDTH = 1280;

export interface PopupWindowFrameSourceOptions {
  /** 弹窗是否已用 Region Capture 把视频轨裁到预览元素。 */
  cropped: boolean;
}

export class PopupWindowFrameSource implements FrameSource {
  readonly width: number;
  readonly height: number;
  private readonly sourceWindow: Window;
  private readonly video: HTMLVideoElement;
  private readonly target: HTMLElement;
  private readonly cropped: boolean;
  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;

  private constructor(args: {
    sourceWindow: Window;
    video: HTMLVideoElement;
    target: HTMLElement;
    cropped: boolean;
    width: number;
    height: number;
  }) {
    this.sourceWindow = args.sourceWindow;
    this.video = args.video;
    this.target = args.target;
    this.cropped = args.cropped;
    this.width = args.width;
    this.height = args.height;
    this.canvas = document.createElement('canvas');
    this.canvas.width = args.width;
    this.canvas.height = args.height;
    const context = this.canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('popup_capture_canvas_unavailable');
    this.context = context;
  }

  static async create(
    sourceWindow: Window,
    options: PopupWindowFrameSourceOptions
  ): Promise<PopupWindowFrameSource> {
    if (typeof window === 'undefined') throw new Error('popup_capture_requires_window');
    let doc: Document;
    try {
      doc = sourceWindow.document;
    } catch {
      throw new Error('popup_capture_unavailable');
    }
    const video = doc.getElementById(CAPTURE_VIDEO_ID) as HTMLVideoElement | null;
    if (!video || video.tagName !== 'VIDEO') throw new Error('popup_capture_video_missing');
    const target = doc.getElementById(CAPTURE_TARGET_ID) as HTMLElement | null;
    if (!target) throw new Error('popup_capture_target_missing');

    await waitForPlayableVideo(video);
    const viewport = {
      width: Math.max(1, sourceWindow.innerWidth),
      height: Math.max(1, sourceWindow.innerHeight)
    };

    let width: number;
    let height: number;
    if (options.cropped) {
      const rect = target.getBoundingClientRect();
      const cssWidth = Math.max(2, Math.round(rect.width));
      const cssHeight = Math.max(2, Math.round(rect.height));
      const scale = Math.min(1, MAX_WIDTH / cssWidth);
      width = Math.max(2, Math.round(cssWidth * scale));
      height = Math.max(2, Math.round(cssHeight * scale));
    } else {
      const crop = computeDisplayCrop({
        videoWidth: video.videoWidth,
        videoHeight: video.videoHeight,
        viewportWidth: viewport.width,
        viewportHeight: viewport.height,
        rect: target.getBoundingClientRect(),
        viewportOffset: windowCaptureOffset(video, viewport),
        maxWidth: MAX_WIDTH
      });
      if (!crop) throw new Error('popup_capture_target_not_visible');
      width = crop.width;
      height = crop.height;
    }

    return new PopupWindowFrameSource({
      sourceWindow,
      video,
      target,
      cropped: options.cropped,
      width,
      height
    });
  }

  async grab(): Promise<HTMLCanvasElement | null> {
    if (this.video.readyState < 2) return null;
    if (this.cropped) {
      const sourceWidth = this.video.videoWidth;
      const sourceHeight = this.video.videoHeight;
      if (sourceWidth <= 0 || sourceHeight <= 0) return null;
      this.context.drawImage(
        this.video,
        0,
        0,
        sourceWidth,
        sourceHeight,
        0,
        0,
        this.width,
        this.height
      );
      return this.canvas;
    }
    const viewport = {
      width: Math.max(1, this.sourceWindow.innerWidth),
      height: Math.max(1, this.sourceWindow.innerHeight)
    };
    const crop = computeDisplayCrop({
      videoWidth: this.video.videoWidth,
      videoHeight: this.video.videoHeight,
      viewportWidth: viewport.width,
      viewportHeight: viewport.height,
      rect: this.target.getBoundingClientRect(),
      viewportOffset: windowCaptureOffset(this.video, viewport),
      maxWidth: MAX_WIDTH
    });
    if (!crop) return null;
    this.context.drawImage(
      this.video,
      crop.sx,
      crop.sy,
      crop.sw,
      crop.sh,
      0,
      0,
      this.width,
      this.height
    );
    return this.canvas;
  }

  /** 流与 video 元素归弹窗所有，宿主只借用帧，不在这里停共享。 */
  dispose(): void {
    // no-op：弹窗在收到产物/失败后自行停止轨道并移除 video。
  }
}

/** 窗口捕获若包含浏览器边框，把多出来的像素折算成 CSS 偏移（顶部对齐）。 */
function windowCaptureOffset(
  video: HTMLVideoElement,
  viewport: { width: number; height: number }
): { x: number; y: number } | undefined {
  if (video.videoWidth <= 0 || video.videoHeight <= 0) return undefined;
  const scale = video.videoWidth / viewport.width;
  if (!Number.isFinite(scale) || scale <= 0) return undefined;
  const extraWidth = Math.max(0, video.videoWidth - viewport.width * scale);
  const extraHeight = Math.max(0, video.videoHeight - viewport.height * scale);
  if (extraWidth < 2 && extraHeight < 2) return undefined;
  return { x: extraWidth / scale / 2, y: extraHeight / scale };
}

function waitForPlayableVideo(video: HTMLVideoElement): Promise<void> {
  if (video.readyState >= 2) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error('popup_capture_video_not_ready'));
    }, 3000);
    const cleanup = () => {
      window.clearTimeout(timer);
      video.removeEventListener('loadeddata', onReady);
      video.removeEventListener('canplay', onReady);
      video.removeEventListener('error', onError);
    };
    const onReady = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error('popup_capture_video_failed'));
    };
    video.addEventListener('loadeddata', onReady);
    video.addEventListener('canplay', onReady);
    video.addEventListener('error', onError);
  });
}
