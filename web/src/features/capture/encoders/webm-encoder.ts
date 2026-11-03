// WebM 编码策略（MediaRecorder 实时录制 canvas.captureStream()）。
// 与 gif/apng 的「先抓帧、后编码」不同，webm 是边录边编——因此它的输入
// 不是帧序列，而是一个「每帧喂给 canvas 的绘制回调 + 总时长」。
// 为对齐统一的 EncodeAnimationRequest 契约（frames 已抓好），这里把帧序
// 列按 frameDelayMs 重放进画布的流里，浏览器用 vp8/vp9 压缩。

import type { EncodeAnimationRequest } from '../types';
import { loadImageFromDataUrl, resolveFrameDelayMs, sleep } from '../frame-utils';

/** 探测候选 matcher，从 format-availability 的同一清单取。 */
const MEDIA_MIME_CANDIDATES = [
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm'
];

function pickSupportedMime(): string | null {
  if (typeof window === 'undefined' || typeof window.MediaRecorder !== 'function') return null;
  try {
    return MEDIA_MIME_CANDIDATES.find((candidate) => window.MediaRecorder.isTypeSupported(candidate)) ?? null;
  } catch {
    return null;
  }
}

function concatChunks(chunks: Blob[]): Blob {
  return new Blob(chunks, { type: 'video/webm' });
}

export async function encodeWebmAnimation(request: EncodeAnimationRequest): Promise<Blob> {
  const mimeType = pickSupportedMime();
  if (!mimeType) throw new Error('webm_encoder_unavailable');

  const canvas = document.createElement('canvas');
  canvas.width = request.width;
  canvas.height = request.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('frame_canvas_context_unavailable');

  // bitsPerSecond 类型差异：老 TS lib 没有 bitrate 相关字段，这里用 any 规避。
  const recorderCtor = window.MediaRecorder as unknown as new (
    stream: MediaStream,
    options: { mimeType: string }
  ) => MediaRecorder;
  const stream = canvas.captureStream(0); // 手动逐帧推进，不靠浏览器自动抽帧
  const track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;
  const recorder = new recorderCtor(stream, { mimeType });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) chunks.push(event.data);
  };

  recorder.start();
  const total = request.frames.length;
  for (let index = 0; index < total; index += 1) {
    if (request.signal?.aborted) {
      try {
        recorder.stop();
      } catch {
        // 忽略停止时的状态错误
      }
      track.stop?.();
      throw new DOMException('capture_aborted', 'AbortError');
    }
    const image = await loadImageFromDataUrl(request.frames[index].dataUrl);
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    // 手动要求 track 捕获本帧；captureStream(0) 需要 requestFrame 驱动。
    track.requestFrame?.();
    // 按真实时间轴重放，保证录出来的 WebM 时长与录制墙钟一致。
    const delayMs = resolveFrameDelayMs(request.frameDelaysMs, index, request.frameDelayMs);
    await sleep(delayMs, request.signal);
    if (index % 5 === 0) request.onProgress?.(total > 0 ? ((index + 1) / total) * 0.6 : 0.6);
  }

  // 等一下再 stop，保证最后一帧有编码时间。
  await sleep(50);
  const stopPromise = new Promise<void>((resolve) => {
    recorder.onstop = () => resolve();
  });
  recorder.stop();
  await stopPromise;
  track.stop?.();
  request.onProgress?.(1);

  const blob = concatChunks(chunks);
  if (blob.size === 0) throw new Error('webm_encode_empty');
  return blob;
}
