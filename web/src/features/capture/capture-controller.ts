// 统一捕获控制器：surface 抓帧 → 编码策略 → 产物。
// 派发只有两条形状分支（still/animation 的类型不同），不许出现按格式名的分支。
//
// 录制时间轴以墙钟为准：
// - 每帧记录相对首帧的真实 atMs，编码时据此生成逐帧 delay；
// - stopSignal 是「手动停止」：停止抓帧后仍编码已抓到的帧；
// - signal 是「硬取消」（组件卸载）：丢弃帧并返回 cancelled。

import type {
  AnimationCaptureFormatId,
  CaptureArtifact,
  CaptureEncodeResult,
  CaptureFrame,
  CaptureNotice,
  EncodeAnimationRequest,
  FrameSource
} from './types';
import { encodeStill } from './still-encoder';
import { getCaptureFormat } from './format-catalog';
import { getAnimationEncoder } from './encoders/encoder-registry';
import { downloadBlobArtifact } from './frame-utils';
import {
  RECORDING_MAX_DURATION_MS,
  RECORDING_MAX_FRAMES
} from './recording-settings';

export interface CaptureStillOptions {
  canvas: HTMLCanvasElement | OffscreenCanvas;
  format: 'png' | 'jpeg' | 'webp';
  baseName: string;
  quality?: number;
}

function fail(code: 'encode_failed', error: unknown): CaptureEncodeResult {
  const message = error instanceof Error ? error.message : 'capture_encode_failed';
  return { ok: false, failure: { code, message, detail: error } };
}

function abortFailure(): CaptureEncodeResult {
  return { ok: false, failure: { code: 'cancelled', message: 'capture_aborted' } };
}

export async function captureStill(options: CaptureStillOptions): Promise<CaptureEncodeResult> {
  try {
    const blob = await encodeStill({
      format: options.format,
      canvas: options.canvas,
      quality: options.quality
    });
    const descriptor = getCaptureFormat(options.format);
    return {
      ok: true,
      artifact: {
        blob,
        mimeType: descriptor.mimeType,
        fileExtension: descriptor.fileExtension,
        suggestedFileName: `${options.baseName || 'capture'}-${Date.now()}.${descriptor.fileExtension}`,
        format: options.format
      }
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return abortFailure();
    return fail('encode_failed', error);
  }
}

export interface CaptureAnimationOptions {
  source: FrameSource;
  format: AnimationCaptureFormatId;
  baseName: string;
  /** 目标采样帧率；实际间隔受抓帧耗时影响，时间轴按真实 atMs 记录。 */
  fps: number;
  /** 最长录制时长（墙钟）。到时停止抓帧并编码已抓到的帧。 */
  maxDurationMs?: number;
  /** 帧数上限；frameCountMode 时抓满即停，否则只是安全上限。 */
  maxFrames?: number;
  /** true 时 onPhase 的 total 是确定目标帧数；false 时 total 为 null（手动停止）。 */
  frameCountMode?: boolean;
  /** 手动停止：停止抓帧后继续编码已抓到的帧（graceful）。 */
  stopSignal?: AbortSignal;
  /** 硬取消：丢弃已抓帧、不产出产物（unmount）。 */
  signal?: AbortSignal;
  /** captured/total 为帧进度，elapsedMs 为相对首帧的真实墙钟时间。 */
  onPhase?: (captured: number, total: number | null, elapsedMs: number) => void;
  onEncode?: (ratio: number) => void;
  /** 录制被 60 秒上限或内存预算提前结束时回调一次。 */
  onNotice?: (notice: CaptureNotice) => void;
}

const MS_PER_SECOND = 1000;
/** 抓帧间隔下限：支持 60fps，同时避免空转抓重复帧。 */
const MIN_INTERVAL_MS = 8;
/** 单次录制允许持有的 dataURL 字符预算（约 192MB，含编码前的原始字符串）。 */
const MAX_FRAME_DATA_CHARS = 192 * 1024 * 1024;
/** 手动模式停止瞬间至少保留两帧，动画格式才有可播放的时长。 */
const MIN_ANIMATION_FRAMES = 2;

function now(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

/**
 * 由真实时间戳生成每帧显示时长：第 i 帧持续到第 i+1 帧被拍下的时刻；
 * 最后一帧沿用前一帧的间隔，保证总时长与录制墙钟一致。
 */
export function computeFrameDelays(frames: CaptureFrame[], fallbackMs: number): number[] {
  if (frames.length <= 1) return [Math.max(1, Math.round(fallbackMs))];
  return frames.map((frame, index) => {
    const next = frames[index + 1];
    const delta = next
      ? next.atMs - frame.atMs
      : frame.atMs - frames[index - 1].atMs;
    return Math.max(1, Math.round(delta));
  });
}

/**
 * 实际有效帧率 = (帧数 - 1) / 首尾真实时间跨度。
 * 抓帧慢于目标帧率时如实下降，绝不用重复帧补足目标帧率。
 */
export function computeEffectiveFps(frames: CaptureFrame[]): number {
  if (frames.length < 2) return 0;
  const spanMs = frames[frames.length - 1].atMs - frames[0].atMs;
  if (!Number.isFinite(spanMs) || spanMs <= 0) return 0;
  return Math.round(((frames.length - 1) / (spanMs / MS_PER_SECOND)) * 10) / 10;
}

export async function captureAnimation(options: CaptureAnimationOptions): Promise<CaptureEncodeResult> {
  const { source, format } = options;
  const intervalMs = Math.max(MIN_INTERVAL_MS, MS_PER_SECOND / Math.max(1, options.fps));
  const maxDurationMs = Math.max(
    intervalMs,
    Math.min(RECORDING_MAX_DURATION_MS, options.maxDurationMs ?? RECORDING_MAX_DURATION_MS)
  );
  const maxFrames = Math.max(
    1,
    Math.min(RECORDING_MAX_FRAMES, Math.round(options.maxFrames ?? RECORDING_MAX_FRAMES))
  );
  const frameCountMode = options.frameCountMode === true;
  const frames: CaptureFrame[] = [];
  const startedAt = now();
  let scheduledAt = startedAt;
  let dataUrlChars = 0;
  let notice: CaptureNotice | null = null;

  const markNotice = (next: CaptureNotice) => {
    if (notice) return;
    notice = next;
    options.onNotice?.(next);
  };

  try {
    while (true) {
      if (options.signal?.aborted) return abortFailure();
      // 停止信号在首帧之前到达时也至少抓一帧，否则「点停止太快」会变成空录制失败。
      if (options.stopSignal?.aborted && frames.length > 0) break;
      if (frames.length >= maxFrames) break;
      const elapsedMs = now() - startedAt;
      if (elapsedMs >= maxDurationMs) {
        markNotice('duration_limit');
        break;
      }
      const image = await source.grab();
      if (!image) return { ok: false, failure: { code: 'encode_failed', message: 'frame_source_unavailable' } };
      // 把 image 落成 dataURL，编码策略统一消费 dataUrl。优先走异步 toBlob，
      // 让 PNG 压缩离开主线程，避免 30/60fps 抓帧时 UI 长时间掉帧。
      const dataUrl = await toDataUrl(image, source, options.signal);
      // 时间戳取抓帧完成时刻：DOM 栅格化本身耗时，用开始时刻会让时间轴偏快。
      const capturedAtMs = Math.round(now() - startedAt);
      frames.push({ dataUrl, atMs: capturedAtMs });
      dataUrlChars += dataUrl.length;
      options.onPhase?.(frames.length, frameCountMode ? maxFrames : null, capturedAtMs);

      if (options.stopSignal?.aborted) break;
      if (frames.length >= maxFrames) break;
      if (dataUrlChars >= MAX_FRAME_DATA_CHARS) {
        markNotice('memory_limit');
        break;
      }

      // 按目标帧率排下一帧；抓帧本身超过间隔时立刻抓下一帧，不补帧。
      scheduledAt += intervalMs;
      const waitMs = scheduledAt - now();
      if (waitMs > 0) {
        await abortableDelay(waitMs, options.signal, options.stopSignal);
      } else {
        // 已经落后于目标帧率：让出一帧给浏览器绘制，避免长时间独占主线程
        // 导致界面卡死。后台标签页的 rAF 会被暂停，此时退化为 setTimeout。
        scheduledAt = now();
        await yieldToPaint();
        if (options.signal?.aborted) return abortFailure();
      }
    }

    if (frames.length === 0) {
      return { ok: false, failure: { code: 'encode_failed', message: 'capture_no_frames' } };
    }
    if (frames.length === 1) {
      // 手动停止得很快时至少补一帧，否则 GIF/APNG 只有一帧（播放器可能不显示）。
      const last = frames[0];
      const duplicateAtMs = last.atMs + Math.max(100, intervalMs);
      frames.push({ dataUrl: last.dataUrl, atMs: duplicateAtMs });
      options.onPhase?.(frames.length, frameCountMode ? maxFrames : null, duplicateAtMs);
    }
    if (frames.length < MIN_ANIMATION_FRAMES) {
      return { ok: false, failure: { code: 'encode_failed', message: 'capture_no_frames' } };
    }

    const encoder = getAnimationEncoder(format).encodeAnimation;
    if (!encoder) return { ok: false, failure: { code: 'encoder_unavailable', message: `no_encoder_${format}` } };
    const request: EncodeAnimationRequest = {
      format,
      frames,
      width: source.width,
      height: source.height,
      frameDelayMs: intervalMs,
      frameDelaysMs: computeFrameDelays(frames, intervalMs),
      baseName: options.baseName,
      signal: options.signal,
      onProgress: (ratio) => options.onEncode?.(ratio)
    };
    const blob = await encoder(request);
    const descriptor = getCaptureFormat(format);
    return {
      ok: true,
      artifact: {
        blob,
        mimeType: descriptor.mimeType,
        fileExtension: descriptor.fileExtension,
        suggestedFileName: `${options.baseName || 'capture'}-${Date.now()}.${descriptor.fileExtension}`,
        format
      },
      notice: notice ?? undefined,
      effectiveFps: computeEffectiveFps(frames)
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return abortFailure();
    return fail('encode_failed', error);
  } finally {
    source.dispose();
  }
}

function toDataUrl(
  image: CanvasImageSource,
  source: FrameSource,
  signal?: AbortSignal
): Promise<string> {
  // 动画抓帧按 scale=1 栅格化时，抓到的 canvas 已经等于目标尺寸，直接导出
  // 省掉一次全画布 drawImage + 编码（每帧数百 ms 的主要成本之一）。
  if (
    typeof HTMLCanvasElement !== 'undefined' &&
    image instanceof HTMLCanvasElement &&
    image.width === source.width &&
    image.height === source.height
  ) {
    return canvasToDataUrl(image, signal);
  }
  const canvas = document.createElement('canvas');
  canvas.width = source.width;
  canvas.height = source.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('capture_canvas_context_unavailable');
  context.drawImage(image, 0, 0, source.width, source.height);
  return canvasToDataUrl(canvas, signal);
}

/**
 * 异步导出 PNG dataURL：`toBlob` 的压缩由浏览器在后台完成，主线程只负责
 * 一次位图快照。拿不到 toBlob 的旧环境回落到同步 toDataURL。
 */
function canvasToDataUrl(canvas: HTMLCanvasElement, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) return Promise.reject(new DOMException('capture_aborted', 'AbortError'));
  if (typeof canvas.toBlob !== 'function' || typeof FileReader === 'undefined') {
    return Promise.resolve(canvas.toDataURL('image/png'));
  }
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (signal?.aborted) {
        reject(new DOMException('capture_aborted', 'AbortError'));
        return;
      }
      if (!blob) {
        reject(new Error('capture_frame_encode_failed'));
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result !== 'string' || !reader.result) {
          reject(new Error('capture_frame_encode_failed'));
          return;
        }
        resolve(reader.result);
      };
      reader.onerror = () => reject(new Error('capture_frame_encode_failed'));
      reader.readAsDataURL(blob);
    }, 'image/png');
  });
}

/** 让出一次绘制机会：优先 scheduler.yield（不额外等一整帧），再退 rAF/setTimeout。 */
function yieldToPaint(): Promise<void> {
  const hidden =
    typeof document !== 'undefined' && document.visibilityState === 'hidden';
  const scheduler = (globalThis as {
    scheduler?: { yield?: () => Promise<void> };
  }).scheduler;
  if (!hidden && typeof scheduler?.yield === 'function') {
    return scheduler.yield();
  }
  if (!hidden && typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
    return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
  }
  return new Promise((resolve) => window.setTimeout(resolve, 0));
}

function abortableDelay(
  ms: number,
  cancelSignal?: AbortSignal,
  stopSignal?: AbortSignal
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (cancelSignal?.aborted) {
      reject(new DOMException('capture_aborted', 'AbortError'));
      return;
    }
    if (stopSignal?.aborted) {
      resolve();
      return;
    }
    const cleanup = () => {
      window.clearTimeout(timer);
      cancelSignal?.removeEventListener('abort', onCancel);
      stopSignal?.removeEventListener('abort', onStop);
    };
    const onCancel = () => {
      cleanup();
      reject(new DOMException('capture_aborted', 'AbortError'));
    };
    const onStop = () => {
      cleanup();
      resolve();
    };
    const timer = window.setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    cancelSignal?.addEventListener('abort', onCancel, { once: true });
    stopSignal?.addEventListener('abort', onStop, { once: true });
  });
}

export function downloadCaptureArtifact(artifact: CaptureArtifact): void {
  downloadBlobArtifact(artifact.blob, artifact.suggestedFileName, artifact.mimeType);
}
