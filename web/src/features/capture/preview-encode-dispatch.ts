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
  resolveRecordingPlan,
  type RecordingSettings
} from './recording-settings';
import type { CaptureWatermarkSettings } from './watermark';

/** 视口宽度兜底（取不到预览容器宽度时用，与弹窗桌面档同量级）。 */
export const FALLBACK_VIEWPORT_WIDTH = 720;
/** 静图整页像素预算：长页面优先降低倍率，仍不够时才截断。 */
export const STILL_MAX_PIXELS = 12_000_000;
/** 静图高度硬上限（避免极端页面把序列化 SVG 撑爆）。 */
export const STILL_MAX_CONTENT_HEIGHT = 32_000;
/** 录制逐帧栅格化，高度/像素预算更保守。 */
export const RECORDING_MAX_CONTENT_HEIGHT = 6_000;
export const RECORDING_MAX_PIXELS = 3_000_000;

/**
 * 静图高度上限按像素预算动态推导：宽度越大允许的页面高度越小，
 * 不再用固定的 10000px（宽画布会先撞像素预算再被静默降倍率）。
 */
export function resolveDocumentHeightLimit(width: number, still: boolean): number {
  if (!still) return RECORDING_MAX_CONTENT_HEIGHT;
  const safeWidth = Math.max(1, Math.round(width));
  return Math.min(
    STILL_MAX_CONTENT_HEIGHT,
    Math.max(1_000, Math.floor(STILL_MAX_PIXELS / safeWidth))
  );
}

interface WatermarkRequest {
  /** 开启后在编码前自动叠加到产物右下角。 */
  watermark?: CaptureWatermarkSettings;
}

export interface PreviewEncodeRequest extends WatermarkRequest {
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
export interface PreviewSourceEncodeRequest extends WatermarkRequest {
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
      const result = await captureStill({
        canvas,
        format: request.format,
        baseName,
        watermark: request.watermark
      });
      return withTruncationNotice(result, source);
    }
    // 上一分支已 return，这里仅剩动画格式；守卫不做负向收窄，显式标注。
    const recording = request.recording ?? RECORDING_DEFAULT_SETTINGS;
    const plan = resolveRecordingPlan(recording);
    const result = await captureAnimation({
      source,
      format: request.format as AnimationCaptureFormatId,
      baseName,
      fps: recording.fps,
      maxDurationMs: plan.maxDurationMs,
      maxFrames: plan.maxFrames,
      frameCountMode: plan.frameCountMode,
      stopSignal: request.stopSignal,
      signal: request.signal,
      watermark: request.watermark,
      onPhase: request.onPhase,
      onEncode: request.onEncode,
      onNotice: (notice) => {
        // duration 模式的时长上限是目标本身，不是「提前结束」。
        if (notice === 'duration_limit' && recording.mode === 'duration') return;
        request.onNotice?.(notice);
      }
    });
    return withTruncationNotice(result, source);
  } finally {
    // captureAnimation 自己也会 dispose；FrameSource 的 dispose 必须幂等。
    source.dispose();
  }
}

/** 整页被裁断时优先级最高：用户必须知道产物不完整。 */
function withTruncationNotice(
  result: CaptureEncodeResult,
  source: FrameSource
): CaptureEncodeResult {
  if (!source.contentTruncated || !result.ok) return result;
  return { ...result, notice: 'content_truncated' };
}

/** 静态克隆路径（完整页面 / 弹窗文档捕获）。 */
export async function encodePreviewDocument(request: PreviewEncodeRequest): Promise<CaptureEncodeResult> {
  const still = isStillCaptureFormat(request.format);
  // 静态克隆不执行脚本：录制必须保留脚本/Canvas/鼠标交互，fail closed。
  if (!still) throw new Error('record_requires_live_stream');
  const width = request.width || FALLBACK_VIEWPORT_WIDTH;
  const source = await DomPreviewFrameSource.create({
    html: request.html,
    width,
    // 动画每帧都要重新栅格化整页，按 1x 渲染避免 4~9 倍像素放大；
    // 静图一次性渲染，仍按 dpr（上限 2x）保证清晰度。
    scale: still ? Math.min(2, window.devicePixelRatio || 1) : 1,
    // 截图的高度上限由像素预算和宽度推出；录制保持固定的 6000px / 3MP。
    maxContentHeight: resolveDocumentHeightLimit(width, still),
    maxPixels: still ? STILL_MAX_PIXELS : RECORDING_MAX_PIXELS
  });
  return encodePreviewSource({
    source,
    format: request.format,
    baseName: 'html-preview',
    recording: request.recording,
    watermark: request.watermark,
    signal: request.signal,
    stopSignal: request.stopSignal,
    onPhase: request.onPhase,
    onEncode: request.onEncode,
    onNotice: request.onNotice
  });
}
