// 格式可用性探测：把「浏览器能不能编这个格式」收敛成一次性的探测表，
// UI 与编码器注册表都从这里读取，而不是到处写 capability if。

import type { CaptureFormatId } from './types';

export interface CaptureFormatAvailability {
  gif: boolean;
  apng: boolean;
  webm: boolean;
  mp4: boolean;
  png: boolean;
  jpeg: boolean;
  webp: boolean;
}

const PROBED: { value: CaptureFormatAvailability | null } = { value: null };

function probeMediaRecorderMime(candidates: string[]): boolean {
  if (typeof window === 'undefined' || typeof window.MediaRecorder !== 'function') return false;
  try {
    return candidates.some((candidate) => window.MediaRecorder.isTypeSupported(candidate));
  } catch {
    return false;
  }
}

export function probeCaptureFormatAvailability(): CaptureFormatAvailability {
  if (PROBED.value) return PROBED.value;
  const webm = probeMediaRecorderMime([
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm'
  ]);
  const value: CaptureFormatAvailability = {
    // GIF 编码器为纯 JS 实现，任何可跑 canvas 的浏览器都可用。
    gif: true,
    // APNG 由自研装配器生成（PNG 帧 + acTL/fcTL 块），不依赖浏览器编码器。
    apng: true,
    webm,
    // 浏览器原生 mp4 录制支持面不稳定（Chrome 126+/Safari 17.4+），v1 不承诺。
    mp4: false,
    png: true,
    jpeg: true,
    webp: true
  };
  PROBED.value = value;
  return value;
}

export function isFormatAvailable(format: CaptureFormatId, availability: CaptureFormatAvailability): boolean {
  return availability[format] === true;
}
