// capture 域内部共享的小工具；对外 API 走 index.ts。

export function loadImageFromDataUrl(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('frame_image_decode_failed'));
    image.src = dataUrl;
    if (image.decode) {
      image.decode().then(() => resolve(image)).catch(() => resolve(image));
    }
  });
}

export function createFrameCanvas(width: number, height: number): {
  canvas: HTMLCanvasElement | OffscreenCanvas;
  context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
} {
  if (typeof OffscreenCanvas === 'function') {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (context) return { canvas, context: context as OffscreenCanvasRenderingContext2D };
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('frame_canvas_context_unavailable');
  return { canvas, context };
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('capture_aborted', 'AbortError'));
      return;
    }
    const timer = window.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, Math.max(0, ms));
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(new DOMException('capture_aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** 大致等间隔地把 frames 切成 maxCount 份（保留首尾）。 */
export function sampleFrames<T>(frames: T[], maxCount: number): T[] {
  if (frames.length <= maxCount) return frames;
  const picked: T[] = [];
  const step = (frames.length - 1) / (maxCount - 1);
  for (let index = 0; index < maxCount; index += 1) {
    picked.push(frames[Math.round(index * step)]);
  }
  return picked;
}

/** 通过 <a download> 把产物交给用户。 */
export function downloadBlobArtifact(blob: Blob, fileName: string, mimeType: string): void {
  const url = window.URL.createObjectURL(new Blob([blob], { type: mimeType }));
  const link = window.document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.rel = 'noopener noreferrer';
  window.document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => window.URL.revokeObjectURL(url), 30_000);
}
