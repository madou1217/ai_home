// 静图编码策略：全部走 CanvasRenderingContext2D.toBlob / OffscreenCanvas.convertToBlob，
// 由浏览器决定具体编解码；PNG/JPEG/WebP 只是参数差异，不需要每格式一个类。

import type { EncodeStillRequest } from './types';
import { getCaptureFormat } from './format-catalog';

export function canvasToBlob(canvas: HTMLCanvasElement | OffscreenCanvas, mimeType: string, quality?: number): Promise<Blob> {
  const context = canvas as HTMLCanvasElement;
  const offscreen = canvas as OffscreenCanvas;
  if (typeof offscreen.convertToBlob === 'function' && !(typeof HTMLCanvasElement !== 'undefined' && canvas instanceof HTMLCanvasElement)) {
    return offscreen.convertToBlob({ type: mimeType, quality });
  }
  if (typeof context.toBlob === 'function') {
    return new Promise((resolve, reject) => {
      context.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('canvas_to_blob_empty'))), mimeType, quality);
    });
  }
  if (typeof offscreen.convertToBlob === 'function') {
    return offscreen.convertToBlob({ type: mimeType, quality });
  }
  throw new Error('canvas_encode_unavailable');
}

export async function encodeStill(request: EncodeStillRequest): Promise<Blob> {
  const descriptor = getCaptureFormat(request.format);
  return canvasToBlob(request.canvas, descriptor.mimeType, request.quality ?? descriptor.quality);
}
