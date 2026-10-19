// GIF 编码策略（策略模式的一个具体实现）。
// gifenc 是纯 JS 量化器 + LZW 编码器，任何可跑 canvas 的浏览器都可用。

import { GIFEncoder, quantize, applyPalette } from 'gifenc';

import type { EncodeAnimationRequest } from '../types';
import { getCaptureFormat } from '../format-catalog';
import { loadImageFromDataUrl, sleep } from '../frame-utils';

/** GIF 编码在主线程解码 RGBA + 量化较重，超限则等比缩到该最长边内。 */
const GIF_MAX_SIZE = 640;
/** 每帧处理之间让出主线程一次，避免 UI 长时间卡帧。 */
const YIELD_MS = 0;
/** 传给 quantize 的最大颜色数（256 包含超出色阶的抖动余量）。 */
const GIF_MAX_COLORS = 256;

type GifFrame = {
  palette: number[][];
  indexed: Uint8Array;
};

function scaleToGifBounds(width: number, height: number): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= GIF_MAX_SIZE) return { width, height };
  const ratio = GIF_MAX_SIZE / longest;
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio))
  };
}

function createEncodeCanvas(width: number, height: number): {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
} {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('frame_canvas_context_unavailable');
  return { canvas, context };
}

async function pullFramePixelData(
  context: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  dataUrl: string,
  signal?: AbortSignal
): Promise<GifFrame> {
  const image = await loadImageFromDataUrl(dataUrl);
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const rgba = context.getImageData(0, 0, canvas.width, canvas.height).data;
  // gifenc 的 quantize/applyPalette 同时接受 Uint8ClampedArray；拷贝一份
  // Uint8Array 保证生命周期，避免依赖 ImageData 底层 buffer 的隐性共享。
  const source = new Uint8Array(rgba.byteLength);
  source.set(rgba);
  const palette = quantize(source, GIF_MAX_COLORS, { format: 'rgb565' });
  const indexed = applyPalette(source, palette, 'rgb565');
  await sleep(YIELD_MS, signal);
  return { palette, indexed };
}

export async function encodeGifAnimation(request: EncodeAnimationRequest): Promise<Blob> {
  const descriptor = getCaptureFormat('gif');
  const delay = Math.max(20, Math.round(request.frameDelayMs));
  const bounds = scaleToGifBounds(request.width, request.height);
  const { canvas, context } = createEncodeCanvas(bounds.width, bounds.height);

  const encoder = GIFEncoder();
  const total = request.frames.length;
  for (let index = 0; index < total; index += 1) {
    if (request.signal?.aborted) throw new DOMException('capture_aborted', 'AbortError');
    const frame = await pullFramePixelData(
      context,
      canvas,
      request.frames[index].dataUrl,
      request.signal
    );
    encoder.writeFrame(frame.indexed, bounds.width, bounds.height, {
      palette: frame.palette,
      delay
    });
    request.onProgress?.(total > 0 ? (index + 1) / total : 1);
  }
  encoder.finish();

  const bytes = encoder.bytes();
  if (!bytes || bytes.length === 0) throw new Error('gif_encode_empty');
  const view = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return new Blob([view], { type: descriptor.mimeType });
}
