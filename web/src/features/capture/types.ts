/**
 * 通用捕获/录制域（capture domain）的公共类型。
 *
 * 设计取向（见 features/capture/registry.ts）：新增一种录制格式 = 在 format-catalog
 * 里加一个格式描述符 + 在 encoders/registry 为它注册一个编码策略；新增一种捕获面
 * （inline 预览 / 独立弹窗预览 / 代码块美化图）= 实现一个 CaptureSurface 描述符，
 * 任何一侧都不允许出现 `if (fmt === '...')` / `if (surface === '...')` 的硬编码分支。
 */

/** 独立预览的默认设备（录制确认框默认选中项）。 */
export type CapturePreviewDevice = 'desktop' | 'mobile';

/** 静态图（单帧）formats。 */
export type StillCaptureFormatId = 'png' | 'jpeg' | 'webp';

/** 动画/视频（多帧序列）formats。 */
export type AnimationCaptureFormatId = 'gif' | 'apng' | 'webm';

export type CaptureFormatId = StillCaptureFormatId | AnimationCaptureFormatId;

export type CaptureFormatKind = 'still' | 'animation';

export interface CaptureFormatDescriptor {
  id: CaptureFormatId;
  kind: CaptureFormatKind;
  /** UI 标签，例如「PNG 静图」「GIF 动图」。 */
  label: string;
  mimeType: string;
  fileExtension: string;
  /** 是否需要逐帧管线（frame pipeline）而非单帧编码。 */
  requiresFramePipeline: boolean;
  /** 默认是否开启（未通过运行时探测否决的格式才出现在 UI 上）。 */
  defaultEnabled?: boolean;
  /** jpeg 的压缩质量（0-1），其他格式忽略。 */
  quality?: number;
}

export interface CaptureSurfaceDescriptor {
  id: string;
  /** UI 用的目标名，如「HTML 预览」「代码块」 */
  label: string;
  kind: 'dom-preview' | 'code-beautify';
  /** 支持的格式集合（捕获面可以收窄，例如代码块美化图只出 PNG）。 */
  formats: CaptureFormatId[];
}

export interface CaptureFrame {
  dataUrl: string;
  /** 相对第一帧的时间戳（ms）。 */
  atMs: number;
}

export interface EncodeStillRequest {
  format: StillCaptureFormatId;
  canvas: HTMLCanvasElement | OffscreenCanvas;
  quality?: number;
}

export interface CaptureAnimationSpec {
  frames: CaptureFrame[];
  width: number;
  height: number;
  /** 帧间目标间隔（ms），编码器可以按格式取整。 */
  frameDelayMs: number;
  /**
   * 每帧实际显示时长（ms，与 frames 等长）。抓帧受 DOM 栅格化耗时影响，
   * 实际间隔往往大于目标帧率；编码器必须优先消费这里的真实时间轴，
   * 否则慢页面录出来会变成「快进」。
   */
  frameDelaysMs?: number[];
  /** 元信息：文件名（不含扩展名）。 */
  baseName: string;
}

export interface EncodeAnimationRequest extends CaptureAnimationSpec {
  format: AnimationCaptureFormatId;
  onProgress?: (ratio: number) => void;
  signal?: AbortSignal;
}

export interface CaptureArtifact {
  blob: Blob;
  mimeType: string;
  fileExtension: string;
  suggestedFileName: string;
  format: CaptureFormatId;
}

export interface CaptureEncodeFailure {
  code: 'encoder_unavailable' | 'encode_failed' | 'cancelled';
  message: string;
  detail?: unknown;
}

/**
 * 录制提前结束/内容不完整的原因（UI 只用来补充提示，不影响产物）。
 * - content_truncated：整页高度超过可捕获上限，底部内容被裁掉。
 */
export type CaptureNotice = 'duration_limit' | 'memory_limit' | 'content_truncated';

export interface CaptureEncodeSuccess {
  ok: true;
  artifact: CaptureArtifact;
  /** 本次捕获的真实限制说明；同一产物只报最主要的一条。 */
  notice?: CaptureNotice;
  /** 动画录制的实际抓帧速率（帧/秒，按真实时间轴计算，不补帧）。 */
  effectiveFps?: number;
}

export type CaptureEncodeResult =
  | CaptureEncodeSuccess
  | { ok: false; failure: CaptureEncodeFailure };

/** 编码器策略：一个 format # 一个策略实现（策略模式）。 */
export interface CaptureEncoderStrategy {
  readonly format: CaptureFormatId;
  encodeStill?(request: EncodeStillRequest): Promise<Blob>;
  encodeAnimation?(request: EncodeAnimationRequest): Promise<Blob>;
}

/** 帧序列采集器：按 surface 各自的方式抓帧（策略模式）。 */
export interface FrameSource {
  /** 目标视口的 CSS 尺寸（device pixel 已在 width/height 中体现）。 */
  readonly width: number;
  readonly height: number;
  /** 抓一帧；返回 null 表示当前不可抓（surface 已被销毁等）。 */
  grab(): Promise<CanvasImageSource | null>;
  /** 释放底层监听/注入（布尔矩阵、rtv 注入等）。 */
  dispose(): void;
}

export interface CaptureTimelineOptions {
  fps: number;
  durationMs: number;
  format: AnimationCaptureFormatId;
}

export type CaptureTimelinePhase =
  | { phase: 'capturing'; capturedFrames: number }
  | { phase: 'encoding'; ratio: number };

export function isStillCaptureFormat(format: CaptureFormatId): format is StillCaptureFormatId {
  return format === 'png' || format === 'jpeg' || format === 'webp';
}

export function isAnimationCaptureFormat(format: CaptureFormatId): format is AnimationCaptureFormatId {
  return !isStillCaptureFormat(format);
}
