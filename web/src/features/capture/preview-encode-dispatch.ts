// 预览编码的统一派发（capture 域内唯一事实源）：
// 静图走 grab→captureStill，动画走帧管线→编码策略。
// 组件层（capture-bridge）与弹窗宿主桥（preview-window-host）共用，
// 只允许 still/animation 两条形状分支，禁止出现按格式名的分支。

import type {
  AnimationCaptureFormatId,
  CaptureEncodeResult,
  CaptureFormatId
} from './types';
import { isStillCaptureFormat } from './types';
import { DomPreviewFrameSource } from './dom-preview-frame-source';
import { captureAnimation, captureStill } from './capture-controller';

/** 录制参数：10fps × 3s ≈ 30 帧，落在 capture-controller 的 MAX_FRAMES=48 之内。 */
const RECORD_FPS = 10;
const RECORD_DURATION_MS = 3000;

/** 视口宽度兜底（取不到预览容器宽度时用，与弹窗桌面档同量级）。 */
export const FALLBACK_VIEWPORT_WIDTH = 720;

export interface PreviewEncodeRequest {
  format: CaptureFormatId;
  html: string;
  width: number;
  signal: AbortSignal;
  onPhase: (captured: number, total: number) => void;
  onEncode: (ratio: number) => void;
}

export async function encodePreviewDocument(request: PreviewEncodeRequest): Promise<CaptureEncodeResult> {
  const source = await DomPreviewFrameSource.create({
    html: request.html,
    width: request.width || FALLBACK_VIEWPORT_WIDTH
  });
  try {
    if (isStillCaptureFormat(request.format)) {
      const canvas = (await source.grab()) as HTMLCanvasElement | null;
      if (!canvas) throw new Error('dom_capture_frame_unavailable');
      return await captureStill({ canvas, format: request.format, baseName: 'html-preview' });
    }
    // 上一分支已 return，这里仅剩动画格式；守卫不做负向收窄，显式标注。
    return await captureAnimation({
      source,
      format: request.format as AnimationCaptureFormatId,
      baseName: 'html-preview',
      fps: RECORD_FPS,
      durationMs: RECORD_DURATION_MS,
      signal: request.signal,
      onPhase: request.onPhase,
      onEncode: request.onEncode
    });
  } finally {
    source.dispose();
  }
}
