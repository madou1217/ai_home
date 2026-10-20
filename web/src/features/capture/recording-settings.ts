// 录制设置（capture 域唯一事实源）：录制方式、帧率、目标帧数与目标时长。
//
// 三种方式共用同一条「抓帧 → 编码」管线，区别只在停止条件：
// - manual：用户点「停止」结束（另有 60 秒硬上限与帧数安全上限）；
// - frames：抓满指定帧数后自动结束（同样受 60 秒硬上限约束）；
// - duration：到达指定墙钟时长后自动结束（帧数只是安全上限）。
// 组件层不得自己解释这些数字，统一从 normalizeRecordingSettings /
// resolveRecordingPlan 取值。

export type RecordingMode = 'manual' | 'frames' | 'duration';

/** 常用采样帧率；UI 只提供这些档位，旧快照会收敛到最接近的档位。 */
export const RECORDING_FPS_OPTIONS = [10, 15, 24, 30, 60] as const;

export type RecordingFps = (typeof RECORDING_FPS_OPTIONS)[number];

export interface RecordingSettings {
  mode: RecordingMode;
  /** 采样目标帧率；抓帧间隔 = 1000 / fps。 */
  fps: RecordingFps;
  /** frames 模式的目标帧数；其它模式忽略。 */
  frameCount: number;
  /** duration 模式的目标时长（秒）；其它模式忽略。 */
  durationSeconds: number;
}

/** 默认帧率：30fps 对大多数 HTML 动效足够，且抓帧/编码压力可控。 */
export const RECORDING_DEFAULT_FPS: RecordingFps = 30;
/** 录制墙钟上限：60 秒（产品约束，不随设置放大）。 */
export const RECORDING_MAX_DURATION_MS = 60_000;
/** 帧数绝对上限 = 60fps × 60s，防止内存被单次录制打爆。 */
export const RECORDING_MAX_FRAMES = 3600;
export const RECORDING_MIN_FRAMES = 2;
/** 默认帧数模式目标（2 秒 @ 30fps）。 */
export const RECORDING_DEFAULT_FRAME_COUNT = 60;
/** 时长模式的取值范围（秒）。 */
export const RECORDING_MIN_DURATION_SECONDS = 1;
export const RECORDING_MAX_DURATION_SECONDS = 60;
export const RECORDING_DEFAULT_DURATION_SECONDS = 6;

/** 默认手动停止：录制中主按钮直接变成可点的「停止」。 */
export const RECORDING_DEFAULT_MODE: RecordingMode = 'manual';

export const RECORDING_DEFAULT_SETTINGS: RecordingSettings = {
  mode: RECORDING_DEFAULT_MODE,
  fps: RECORDING_DEFAULT_FPS,
  frameCount: RECORDING_DEFAULT_FRAME_COUNT,
  durationSeconds: RECORDING_DEFAULT_DURATION_SECONDS
};

/** 由录制设置推导出的抓帧计划；capture-controller 只消费这些数字。 */
export interface RecordingPlan {
  /** 本次录制允许抓取的帧数上限。 */
  maxFrames: number;
  /** 本次录制的墙钟上限（ms）。 */
  maxDurationMs: number;
  /** true 时进度可显示确定的帧数总数。 */
  frameCountMode: boolean;
  /** 本次录制的目标采样帧率（编码器用它作为缺失时间轴的兜底）。 */
  fps: RecordingFps;
}

function clampFrameCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return RECORDING_DEFAULT_FRAME_COUNT;
  }
  return Math.min(RECORDING_MAX_FRAMES, Math.max(RECORDING_MIN_FRAMES, Math.round(value)));
}

function clampDurationSeconds(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return RECORDING_DEFAULT_DURATION_SECONDS;
  }
  return Math.min(
    RECORDING_MAX_DURATION_SECONDS,
    Math.max(RECORDING_MIN_DURATION_SECONDS, Math.round(value))
  );
}

function clampFps(value: unknown): RecordingFps {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return RECORDING_DEFAULT_FPS;
  }
  let nearest: RecordingFps = RECORDING_FPS_OPTIONS[0];
  let smallestDelta = Number.POSITIVE_INFINITY;
  for (const option of RECORDING_FPS_OPTIONS) {
    const delta = Math.abs(option - value);
    if (delta < smallestDelta || (delta === smallestDelta && option > nearest)) {
      nearest = option;
      smallestDelta = delta;
    }
  }
  return nearest;
}

/** 把任意帧率收敛到可用档位（UI 与旧快照共用）。 */
export function normalizeRecordingFps(value: unknown): RecordingFps {
  return clampFps(value);
}

function normalizeMode(value: unknown): RecordingMode {
  if (value === 'frames' || value === 'duration') return value;
  return 'manual';
}

/** 把任意来源（localStorage / postMessage / 旧快照）的录制设置收敛到合法值。 */
export function normalizeRecordingSettings(
  input?: Partial<RecordingSettings> | null
): RecordingSettings {
  return {
    mode: normalizeMode(input?.mode),
    fps: clampFps(input?.fps),
    frameCount: clampFrameCount(input?.frameCount),
    durationSeconds: clampDurationSeconds(input?.durationSeconds)
  };
}

/**
 * 录制设置 → 抓帧计划。
 * duration 模式按目标帧率折算帧数上限，避免慢页面在时长到达前抓出超额帧。
 */
export function resolveRecordingPlan(
  input?: Partial<RecordingSettings> | null
): RecordingPlan {
  const settings = normalizeRecordingSettings(input);
  if (settings.mode === 'frames') {
    return {
      maxFrames: settings.frameCount,
      maxDurationMs: RECORDING_MAX_DURATION_MS,
      frameCountMode: true,
      fps: settings.fps
    };
  }
  if (settings.mode === 'duration') {
    return {
      maxFrames: Math.min(
        RECORDING_MAX_FRAMES,
        Math.max(
          RECORDING_MIN_FRAMES,
          Math.round(settings.durationSeconds * settings.fps)
        )
      ),
      maxDurationMs: settings.durationSeconds * 1000,
      frameCountMode: true,
      fps: settings.fps
    };
  }
  return {
    maxFrames: RECORDING_MAX_FRAMES,
    maxDurationMs: RECORDING_MAX_DURATION_MS,
    frameCountMode: false,
    fps: settings.fps
  };
}

/** 菜单/设置行里的短摘要。 */
export function summarizeRecordingSettings(
  input?: Partial<RecordingSettings> | null
): string {
  const settings = normalizeRecordingSettings(input);
  if (settings.mode === 'frames') return `${settings.fps}fps · ${settings.frameCount} 帧`;
  if (settings.mode === 'duration') return `${settings.fps}fps · ${settings.durationSeconds} 秒`;
  return `${settings.fps}fps · 手动停止`;
}

/** 设置行副标题里的完整说明。 */
export function describeRecordingSettings(
  input?: Partial<RecordingSettings> | null
): string {
  const settings = normalizeRecordingSettings(input);
  if (settings.mode === 'frames') {
    const seconds = (settings.frameCount / settings.fps).toFixed(1);
    return `${settings.fps} fps · 抓满 ${settings.frameCount} 帧后自动结束（约 ${seconds} 秒）`;
  }
  if (settings.mode === 'duration') {
    const frames = Math.round(settings.durationSeconds * settings.fps);
    return `${settings.fps} fps · 录制 ${settings.durationSeconds} 秒后自动结束（约 ${frames} 帧）`;
  }
  return `${settings.fps} fps · 由你点击「停止」结束，最长 ${RECORDING_MAX_DURATION_SECONDS} 秒`;
}
