// UI 层与 capture 域之间的桥接：每个 HTML 预览面挂一份 usePreviewCaptureActions。
// 组件只感知「动作 + 状态」；帧源实现与编码派发留在 capture 域。
// still/animation 的两条形状分支是这里仅有的分派点，禁止出现按格式名的分支。

import { useCallback, useEffect, useRef, useState } from 'react';
import { message } from 'antd';
import type {
  AnimationCaptureFormatId,
  CaptureEncodeResult,
  CaptureFormatAvailability,
  CaptureFormatId,
  CapturePreferences
} from '../../features/capture';
import {
  DomPreviewFrameSource,
  captureAnimation,
  captureStill,
  downloadCaptureArtifact,
  isAnimationCaptureFormat,
  isFormatAvailable,
  isStillCaptureFormat,
  listAnimationFormats,
  probeCaptureFormatAvailability,
  readCapturePreferences
} from '../../features/capture';

/** 录制参数：10fps × 3s ≈ 30 帧，落在 capture-controller 的 MAX_FRAMES=48 之内。 */
const RECORD_FPS = 10;
const RECORD_DURATION_MS = 3000;

/** 视口宽度兜底（取不到预览容器宽度时用，与弹窗桌面档同量级）。 */
const FALLBACK_VIEWPORT_WIDTH = 720;

export interface PreviewCaptureState {
  busy: boolean;
  progressLabel: string;
}

export interface PreviewCaptureActions {
  state: PreviewCaptureState;
  runFormat: (format: CaptureFormatId) => Promise<void>;
}

export interface PreviewCaptureActionsOptions {
  /** 当前预览文档（完整 HTML），每次执行时取最新值。 */
  getPreviewDoc: () => string;
  /** 预览视口宽度（与用户实际看到的宽度一致）。 */
  getViewportWidth: () => number;
}

export interface RecordFormatOption {
  id: AnimationCaptureFormatId;
  label: string;
}

/** 可选录制格式 = 全局启用矩阵 ∩ 浏览器探测能力；落库偏好是唯一事实源。 */
export function listRecordableAnimationFormats(
  deps: {
    availability?: CaptureFormatAvailability;
    preferences?: CapturePreferences;
  } = {}
): RecordFormatOption[] {
  const availability = deps.availability ?? probeCaptureFormatAvailability();
  const prefs = deps.preferences ?? readCapturePreferences();
  return listAnimationFormats()
    .filter((format) => prefs.enabledFormats[format.id] && isFormatAvailable(format.id, availability))
    .map((format) => ({ id: format.id, label: format.label }));
}

/** 主按钮默认动作：偏好默认格式（必须启用且在可选清单里），否则清单第一项。 */
export function resolveDefaultRecordFormat(
  options: RecordFormatOption[],
  preferences: CapturePreferences = readCapturePreferences()
): AnimationCaptureFormatId | null {
  const preferred = preferences.defaultFormat;
  if (isAnimationCaptureFormat(preferred) && preferences.enabledFormats[preferred] && options.some((option) => option.id === preferred)) {
    return preferred;
  }
  return options[0]?.id ?? null;
}

export function usePreviewCaptureActions(options: PreviewCaptureActionsOptions): PreviewCaptureActions {
  const [state, setState] = useState<PreviewCaptureState>({ busy: false, progressLabel: '' });
  const busyRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const finish = useCallback(() => {
    busyRef.current = false;
    abortRef.current = null;
    setState({ busy: false, progressLabel: '' });
  }, []);

  const runFormat = useCallback(async (format: CaptureFormatId) => {
    if (busyRef.current) return;
    busyRef.current = true;
    const controller = new AbortController();
    abortRef.current = controller;
    const still = isStillCaptureFormat(format);
    setState({ busy: true, progressLabel: still ? '正在生成截图…' : '正在录制…' });
    try {
      const result = await runEncode(format, {
        html: optionsRef.current.getPreviewDoc(),
        width: optionsRef.current.getViewportWidth() || FALLBACK_VIEWPORT_WIDTH,
        signal: controller.signal,
        onPhase: (captured, total) => setState({ busy: true, progressLabel: `正在抓帧 ${captured}/${total}…` }),
        onEncode: (ratio) => setState({ busy: true, progressLabel: `正在编码 ${Math.round(ratio * 100)}%…` })
      });
      if (result.ok) {
        downloadCaptureArtifact(result.artifact);
        message.success(still ? '截图已保存' : '录制已保存');
      } else if (result.failure.code !== 'cancelled') {
        message.error(failureText(result.failure.message));
      }
    } catch (error) {
      message.error(unknownErrorText(error));
    } finally {
      finish();
    }
  }, [finish]);

  useEffect(() => () => abortRef.current?.abort(), []);

  return { state, runFormat };
}

interface EncodeDispatchRequest {
  html: string;
  width: number;
  signal: AbortSignal;
  onPhase: (captured: number, total: number) => void;
  onEncode: (ratio: number) => void;
}

/** 统一编码派发：静图走 grab→captureStill，动画走帧管线→编码策略。 */
async function runEncode(format: CaptureFormatId, request: EncodeDispatchRequest): Promise<CaptureEncodeResult> {
  const source = await DomPreviewFrameSource.create({ html: request.html, width: request.width });
  try {
    if (isStillCaptureFormat(format)) {
      const canvas = (await source.grab()) as HTMLCanvasElement | null;
      if (!canvas) throw new Error('dom_capture_frame_unavailable');
      return await captureStill({ canvas, format, baseName: 'html-preview' });
    }
    // 上一分支已 return，这里仅剩动画格式；守卫不做负向收窄，显式标注。
    return await captureAnimation({
      source,
      format: format as AnimationCaptureFormatId,
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

function failureText(raw: string): string {
  if (raw === 'frame_source_unavailable') return '预览暂不可截取';
  if (raw === 'webm_encoder_unavailable') return '当前浏览器不支持 WebM 录制';
  if (raw === 'webm_encode_empty') return '录制的帧数据为空，请重试';
  return `操作失败：${raw}`;
}

function unknownErrorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (raw === 'dom_capture_load_timeout') return '预览渲染超时，请重试';
  if (raw === 'dom_capture_load_failed') return '预览克隆失败，请重试';
  return `操作失败：${raw}`;
}
