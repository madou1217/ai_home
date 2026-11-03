// 实时预览抓帧源：截取「用户此刻真正看到的」预览画面（脚本、Canvas、WebGL、
// 滚动与旋转都包含在内），而不是把 HTML 克隆成一个不执行脚本的静态文档。
//
// 浏览器只提供 `getDisplayMedia` 这一条不破坏 sandbox 的实时取景通道：
// - 首选 Region Capture（Chrome 104+）：把视频轨直接裁到目标元素；
// - 不支持时回退到「整页/整窗视频 + 按元素 rect 裁切」。
// `getDisplayMedia` 必须由用户手势触发，因此 create() 的第一条语句就是
// 同步调用它（在第一个 await 之前），调用方也要保证从点击处理器一路同步进入。

import type { FrameSource } from './types';

export interface LivePreviewFrameSourceOptions {
  /** 要捕获的预览容器（包含 iframe 的 stage）。 */
  target: HTMLElement;
  /** 捕获面提示；inline 预览用 browser，独立窗口用 window。 */
  displaySurface?: 'browser' | 'window';
  /** Chrome：优先预选当前标签页，减少用户选错。 */
  preferCurrentTab?: boolean;
  /** 目标视口尺寸；默认当前窗口。独立弹窗传入弹窗自己的 innerWidth/Height。 */
  viewport?: { width: number; height: number };
  /** 捕获面相对视口的偏移（窗口捕获包含浏览器边框时使用）。 */
  viewportOffset?: { x: number; y: number };
  /** 输出画布的最大宽度，避免 5K 屏把帧数据打爆。 */
  maxWidth?: number;
  /** 请求的屏幕共享帧率；默认 30fps。 */
  frameRate?: number;
}

export interface DisplayCropInput {
  videoWidth: number;
  videoHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  rect: { left: number; top: number; width: number; height: number };
  viewportOffset?: { x: number; y: number };
  maxWidth?: number;
}

export interface DisplayCropResult {
  /** 视频源裁切区域（视频像素）。 */
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  /** 输出画布尺寸（CSS 像素，按 maxWidth 等比缩放）。 */
  width: number;
  height: number;
}

const DEFAULT_MAX_WIDTH = 1280;
/** 判定目标完整可见时的像素容差（亚像素/缩放误差）。 */
const FULL_VISIBILITY_TOLERANCE = 1;

/**
 * 目标元素是否完整落在视口内（录制不能只抓可见的一部分）。
 * 返回 false 时调用方应先滚动/调整布局，再重试；仍不满足则明确报错。
 */
export function isTargetFullyVisible(
  target: HTMLElement,
  viewport: { width: number; height: number }
): boolean {
  const rect = target.getBoundingClientRect();
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    rect.left >= -FULL_VISIBILITY_TOLERANCE &&
    rect.top >= -FULL_VISIBILITY_TOLERANCE &&
    rect.right <= viewport.width + FULL_VISIBILITY_TOLERANCE &&
    rect.bottom <= viewport.height + FULL_VISIBILITY_TOLERANCE
  );
}

/**
 * 点击录制时把预览目标滚动到视口中央，保证整个可视区域可见。
 * 必须在 `getDisplayMedia` 之前同步调用（保住用户手势）；滚动失败或目标
 * 仍不完整可见时由调用方 fail closed，绝不静默裁掉被聊天界面遮挡的部分。
 */
export function revealCaptureTarget(
  target: HTMLElement,
  viewport: { width: number; height: number } = {
    width: Math.max(1, window.innerWidth),
    height: Math.max(1, window.innerHeight)
  }
): void {
  if (isTargetFullyVisible(target, viewport)) return;
  target.scrollIntoView({
    block: 'center',
    inline: 'nearest',
    behavior: 'instant' as ScrollBehavior
  });
  // 强制布局，确保后续可见性判定看到滚动后的位置。
  void target.getBoundingClientRect();
}

/**
 * 把「页面坐标里的元素 rect」换算成视频源裁切区域与输出尺寸。
 * 纯函数，便于单测覆盖 Retina、部分离屏和窗口偏移三种情况。
 */
export function computeDisplayCrop(input: DisplayCropInput): DisplayCropResult | null {
  const {
    videoWidth,
    videoHeight,
    viewportWidth,
    viewportHeight,
    rect,
    viewportOffset
  } = input;
  if (
    videoWidth <= 0 ||
    videoHeight <= 0 ||
    viewportWidth <= 0 ||
    viewportHeight <= 0 ||
    rect.width <= 0 ||
    rect.height <= 0
  ) {
    return null;
  }
  const offsetX = viewportOffset?.x ?? 0;
  const offsetY = viewportOffset?.y ?? 0;
  const left = Math.max(0, rect.left);
  const top = Math.max(0, rect.top);
  const right = Math.min(viewportWidth, rect.left + rect.width);
  const bottom = Math.min(viewportHeight, rect.top + rect.height);
  const visibleWidth = right - left;
  const visibleHeight = bottom - top;
  if (visibleWidth < 1 || visibleHeight < 1) return null;

  // 无窗口边框时两轴各自按视频/视口比例；有边框时边框只改变视频尺寸，
  // 内容缩放取水平方向（窗口左右边框对称，宽度比值最可靠）。
  const scaleX = videoWidth / viewportWidth;
  const hasViewportOffset = offsetX > 0 || offsetY > 0;
  const scaleY = hasViewportOffset ? scaleX : videoHeight / viewportHeight;
  const maxWidth = Math.max(1, input.maxWidth ?? DEFAULT_MAX_WIDTH);
  const outputWidth = Math.min(maxWidth, Math.max(1, Math.round(visibleWidth)));
  const outputHeight = Math.max(
    1,
    Math.round((outputWidth / visibleWidth) * visibleHeight)
  );
  return {
    sx: (offsetX + left) * scaleX,
    sy: (offsetY + top) * scaleY,
    sw: visibleWidth * scaleX,
    sh: visibleHeight * scaleY,
    width: outputWidth,
    height: outputHeight
  };
}

interface CropTargetLike {
  fromElement(element: Element): Promise<unknown>;
}

interface CropToTrack {
  cropTo(target: unknown): Promise<void>;
}

function getCropTargetCtor(): CropTargetLike | null {
  if (typeof window === 'undefined') return null;
  const candidate = (window as unknown as { CropTarget?: CropTargetLike }).CropTarget;
  return candidate && typeof candidate.fromElement === 'function' ? candidate : null;
}

async function cropStreamToElement(stream: MediaStream, target: HTMLElement): Promise<boolean> {
  const ctor = getCropTargetCtor();
  const track = stream.getVideoTracks()[0] as MediaStreamTrack & Partial<CropToTrack>;
  if (!ctor || !track || typeof track.cropTo !== 'function') return false;
  try {
    const cropTarget = await ctor.fromElement(target);
    await track.cropTo(cropTarget);
    return true;
  } catch {
    // 用户共享了别的标签页/窗口时 CropTarget 会拒绝；回退到 rect 裁切，
    // 由调用方通过画面内容自行判断是否选错。
    return false;
  }
}

export class LivePreviewFrameSource implements FrameSource {
  readonly width: number;
  readonly height: number;
  private readonly target: HTMLElement;
  private readonly video: HTMLVideoElement;
  private readonly stream: MediaStream;
  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly cropped: boolean;
  private readonly viewport: { width: number; height: number };
  private readonly viewportOffset?: { x: number; y: number };
  private readonly maxWidth: number;
  private ended = false;
  private disposed = false;

  private constructor(args: {
    target: HTMLElement;
    video: HTMLVideoElement;
    stream: MediaStream;
    cropped: boolean;
    viewport: { width: number; height: number };
    viewportOffset?: { x: number; y: number };
    maxWidth: number;
    width: number;
    height: number;
  }) {
    this.target = args.target;
    this.video = args.video;
    this.stream = args.stream;
    this.cropped = args.cropped;
    this.viewport = args.viewport;
    this.viewportOffset = args.viewportOffset;
    this.maxWidth = args.maxWidth;
    this.width = args.width;
    this.height = args.height;
    this.canvas = document.createElement('canvas');
    this.canvas.width = args.width;
    this.canvas.height = args.height;
    const context = this.canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('display_capture_canvas_unavailable');
    this.context = context;

    const track = this.stream.getVideoTracks()[0];
    track?.addEventListener('ended', () => {
      this.ended = true;
    });
  }

  static async create(options: LivePreviewFrameSourceOptions): Promise<LivePreviewFrameSource> {
    if (typeof window === 'undefined') throw new Error('display_capture_requires_window');
    if (!options.target.isConnected) throw new Error('display_capture_target_detached');

    const viewport = options.viewport ?? {
      width: Math.max(1, window.innerWidth),
      height: Math.max(1, window.innerHeight)
    };
    // 录制的取景范围就是屏幕上的可见像素：先把目标完整滚到视口中央，
    // 否则 computeDisplayCrop 会静默裁掉被聊天滚动区/固定区域挡住的部分。
    revealCaptureTarget(options.target, viewport);
    if (!isTargetFullyVisible(options.target, viewport)) {
      throw new Error('preview_not_visible');
    }

    // 关键：同步进入 getDisplayMedia，保住用户手势（点击「录制/截图」）。
    const stream = await requestDisplayStream(options);

    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;
    video.setAttribute('data-aih-live-capture', '');
    video.setAttribute('aria-hidden', 'true');
    video.style.position = 'fixed';
    video.style.left = '-10000px';
    video.style.top = '0';
    video.style.width = '2px';
    video.style.height = '2px';
    video.style.opacity = '0';
    video.style.pointerEvents = 'none';
    video.srcObject = stream;
    document.body.appendChild(video);

    try {
      await waitForVideoMetadata(video);
      await video.play();
    } catch (error) {
      stopStream(stream);
      video.remove();
      throw error;
    }

    const cropped = await cropStreamToElement(stream, options.target);
    if (cropped) {
      // 裁切后的轨道尺寸要等下一帧才反映到 video.videoWidth。
      await nextFrame();
    }

    const rect = options.target.getBoundingClientRect();
    const maxWidth = Math.max(320, options.maxWidth ?? DEFAULT_MAX_WIDTH);

    let width: number;
    let height: number;
    if (cropped) {
      // Region Capture 已经把视频轨裁到目标元素；输出尺寸按元素的 CSS 尺寸
      // 计算，不依赖 video.videoWidth（裁切后轨道尺寸的刷新时机因实现而异）。
      const cssWidth = Math.max(2, Math.round(rect.width));
      const cssHeight = Math.max(2, Math.round(rect.height));
      const scale = Math.min(1, maxWidth / cssWidth);
      width = Math.max(2, Math.round(cssWidth * scale));
      height = Math.max(2, Math.round(cssHeight * scale));
    } else {
      const crop = computeDisplayCrop({
        videoWidth: video.videoWidth,
        videoHeight: video.videoHeight,
        viewportWidth: viewport.width,
        viewportHeight: viewport.height,
        rect,
        viewportOffset: options.viewportOffset,
        maxWidth
      });
      if (!crop) {
        stopStream(stream);
        video.remove();
        throw new Error('preview_not_visible');
      }
      width = crop.width;
      height = crop.height;
    }

    return new LivePreviewFrameSource({
      target: options.target,
      video,
      stream,
      cropped,
      viewport,
      viewportOffset: options.viewportOffset,
      maxWidth,
      width,
      height
    });
  }

  async grab(): Promise<HTMLCanvasElement | null> {
    if (this.disposed || this.ended) return null;
    if (this.video.readyState < 2) return null;
    if (this.cropped) {
      const sourceWidth = this.video.videoWidth;
      const sourceHeight = this.video.videoHeight;
      if (sourceWidth <= 0 || sourceHeight <= 0) return null;
      this.context.drawImage(this.video, 0, 0, sourceWidth, sourceHeight, 0, 0, this.width, this.height);
      return this.canvas;
    }
    const crop = computeDisplayCrop({
      videoWidth: this.video.videoWidth,
      videoHeight: this.video.videoHeight,
      viewportWidth: this.viewport.width,
      viewportHeight: this.viewport.height,
      rect: this.target.getBoundingClientRect(),
      viewportOffset: this.viewportOffset,
      maxWidth: this.maxWidth
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

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    stopStream(this.stream);
    this.video.pause();
    this.video.srcObject = null;
    this.video.remove();
  }
}

async function requestDisplayStream(options: LivePreviewFrameSourceOptions): Promise<MediaStream> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getDisplayMedia) {
    throw new Error('display_capture_unavailable');
  }
  const constraints: DisplayMediaStreamOptions & {
    preferCurrentTab?: boolean;
  } = {
    video: {
      frameRate: Math.max(1, Math.min(60, Math.round(options.frameRate ?? 30))),
      ...(options.displaySurface ? { displaySurface: options.displaySurface } : {})
    } as MediaTrackConstraints,
    audio: false,
    ...(options.preferCurrentTab ? { preferCurrentTab: true } : {})
  };
  return navigator.mediaDevices.getDisplayMedia(constraints);
}

function waitForVideoMetadata(video: HTMLVideoElement): Promise<void> {
  if (video.readyState >= HTMLMediaElement.HAVE_METADATA) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      video.removeEventListener('loadedmetadata', onLoaded);
      video.removeEventListener('error', onError);
    };
    const onLoaded = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error('display_capture_video_failed'));
    };
    video.addEventListener('loadedmetadata', onLoaded);
    video.addEventListener('error', onError);
  });
}

function stopStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      // 轨道已被浏览器回收时 stop() 可能抛错，忽略即可。
    }
  }
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => resolve());
      return;
    }
    window.setTimeout(resolve, 16);
  });
}
