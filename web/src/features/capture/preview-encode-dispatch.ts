// 预览编码的统一派发（capture 域内唯一事实源）：
// 静图走 grab→captureStill，动画走帧管线→编码策略。
// 组件层（capture-bridge）与弹窗宿主桥（preview-window-host）共用，
// 只允许 still/animation 两条形状分支，禁止出现按格式名的分支。

import type {
  AnimationCaptureFormatId,
  CaptureEncodeResult,
  CaptureFormatId,
  CaptureNotice,
  FrameSource
} from './types';
import { isStillCaptureFormat } from './types';
import { DomPreviewFrameSource } from './dom-preview-frame-source';
import { captureAnimation, captureStill } from './capture-controller';
import {
  RECORDING_DEFAULT_SETTINGS,
  RECORDING_FPS,
  resolveRecordingPlan,
  type RecordingSettings
} from './recording-settings';

/** 视口宽度兜底（取不到预览容器宽度时用，与弹窗桌面档同量级）。 */
export const FALLBACK_VIEWPORT_WIDTH = 720;

export interface PreviewEncodeRequest {
  format: CaptureFormatId;
  html: string;
  width: number;
  /** 本次录制的停止条件；静图忽略。 */
  recording?: RecordingSettings;
  /** 硬取消（组件卸载）：丢弃帧、不产出产物。 */
  signal: AbortSignal;
  /** 手动停止（录制按钮 → 停止）：保留已抓帧并继续编码。 */
  stopSignal?: AbortSignal;
  onPhase: (captured: number, total: number | null, elapsedMs: number) => void;
  onEncode: (ratio: number) => void;
  onNotice?: (notice: CaptureNotice) => void;
}

/**
 * 对任意 FrameSource 执行一次截图/录制。
 * inline 预览用实时屏幕抓帧源，弹窗宿主用弹窗视频帧源，二者共用这一条编码派发。
 */
export interface PreviewSourceEncodeRequest {
  source: FrameSource;
  format: CaptureFormatId;
  /** 产物文件名（不含扩展名）；缺省 html-preview。 */
  baseName?: string;
  /** 本次录制的停止条件；静图忽略。 */
  recording?: RecordingSettings;
  /** 硬取消（组件卸载）：丢弃帧、不产出产物。 */
  signal: AbortSignal;
  /** 手动停止（录制按钮 → 停止）：保留已抓帧并继续编码。 */
  stopSignal?: AbortSignal;
  onPhase: (captured: number, total: number | null, elapsedMs: number) => void;
  onEncode: (ratio: number) => void;
  onNotice?: (notice: CaptureNotice) => void;
}

export async function encodePreviewSource(
  request: PreviewSourceEncodeRequest
): Promise<CaptureEncodeResult> {
  const { source } = request;
  const baseName = request.baseName || 'html-preview';
  try {
    if (isStillCaptureFormat(request.format)) {
      const canvas = (await source.grab()) as HTMLCanvasElement | null;
      if (!canvas) throw new Error('frame_source_unavailable');
      return await captureStill({ canvas, format: request.format, baseName });
    }
    // 上一分支已 return，这里仅剩动画格式；守卫不做负向收窄，显式标注。
    const recording = request.recording ?? RECORDING_DEFAULT_SETTINGS;
    const plan = resolveRecordingPlan(recording);
    return await captureAnimation({
      source,
      format: request.format as AnimationCaptureFormatId,
      baseName,
      fps: RECORDING_FPS,
      maxDurationMs: plan.maxDurationMs,
      maxFrames: plan.maxFrames,
      frameCountMode: plan.frameCountMode,
      stopSignal: request.stopSignal,
      signal: request.signal,
      onPhase: request.onPhase,
      onEncode: request.onEncode,
      onNotice: (notice) => {
        // duration 模式的时长上限是目标本身，不是「提前结束」。
        if (notice === 'duration_limit' && recording.mode === 'duration') return;
        request.onNotice?.(notice);
      }
    });
  } finally {
    // captureAnimation 自己也会 dispose；FrameSource 的 dispose 必须幂等。
    source.dispose();
  }
}

/** 静态克隆路径（弹窗旧协议 / 无实时取景时的回退）。 */
export async function encodePreviewDocument(request: PreviewEncodeRequest): Promise<CaptureEncodeResult> {
  const source = await DomPreviewFrameSource.create({
    html: request.html,
    width: request.width || FALLBACK_VIEWPORT_WIDTH
  });
  return encodePreviewSource({
    source,
    format: request.format,
    baseName: 'html-preview',
    recording: request.recording,
    signal: request.signal,
    stopSignal: request.stopSignal,
    onPhase: request.onPhase,
    onEncode: request.onEncode,
    onNotice: request.onNotice
  });
}
