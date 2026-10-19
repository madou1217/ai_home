// 统一捕获控制器：surface 抓帧 → 编码策略 → 产物。
// 派发只有两条形状分支（still/animation 的类型不同），不许出现按格式名的分支。

import type {
  AnimationCaptureFormatId,
  CaptureArtifact,
  CaptureEncodeResult,
  EncodeAnimationRequest,
  FrameSource
} from './types';
import { encodeStill } from './still-encoder';
import { getCaptureFormat } from './format-catalog';
import { getAnimationEncoder } from './encoders/encoder-registry';
import { downloadBlobArtifact } from './frame-utils';

export interface CaptureStillOptions {
  canvas: HTMLCanvasElement | OffscreenCanvas;
  format: StillCaptureFormatId;
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
  /** 帧率与时长决定抓多少帧。 */
  fps: number;
  durationMs: number;
  signal?: AbortSignal;
  onPhase?: (captured: number, total: number) => void;
  onEncode?: (ratio: number) => void;
}

const MS_PER_SECOND = 1000;
/** 帧序列的最大帧数上限，防止长间隔误输入导致 OOM。 */
const MAX_FRAMES = 48;

export async function captureAnimation(options: CaptureAnimationOptions): Promise<CaptureEncodeResult> {
  const { source, format } = options;
  const intervalMs = Math.max(40, MS_PER_SECOND / Math.max(1, options.fps));
  const totalFrames = Math.max(2, Math.min(MAX_FRAMES, Math.round((options.durationMs / intervalMs) || 8)));
  const frames = [];

  try {
    for (let index = 0; index < totalFrames; index += 1) {
      if (options.signal?.aborted) return abortFailure();
      const image = await source.grab();
      if (!image) return { ok: false, failure: { code: 'encode_failed', message: 'frame_source_unavailable' } };
      // 把 image 落成 dataURL，编码策略统一消费 dataUrl。
      const dataUrl = toDataUrl(image, source);
      frames.push({ dataUrl, atMs: index * intervalMs });
      options.onPhase?.(index + 1, totalFrames);
      if (index < totalFrames - 1) {
        await abortableDelay(intervalMs, options.signal);
      }
    }

    const encoder = getAnimationEncoder(format).encodeAnimation;
    if (!encoder) return { ok: false, failure: { code: 'encoder_unavailable', message: `no_encoder_${format}` } };
    const request: EncodeAnimationRequest = {
      format,
      frames,
      width: source.width,
      height: source.height,
      frameDelayMs: intervalMs,
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
      }
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return abortFailure();
    return fail('encode_failed', error);
  } finally {
    source.dispose();
  }
}

function toDataUrl(image: CanvasImageSource, source: FrameSource): string {
  // frame-utils 里统一的 dataURL 抽取；仍然显式写在这里保证 capture controller
  // 是唯一负责 CSS 尺寸→像素换算的层。
  const canvas = document.createElement('canvas');
  canvas.width = source.width;
  canvas.height = source.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('capture_canvas_context_unavailable');
  context.drawImage(image, 0, 0, source.width, source.height);
  return canvas.toDataURL('image/png');
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('capture_aborted', 'AbortError'));
      return;
    }
    const timer = window.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(new DOMException('capture_aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function downloadCaptureArtifact(artifact: CaptureArtifact): void {
  downloadBlobArtifact(artifact.blob, artifact.suggestedFileName, artifact.mimeType);
}
