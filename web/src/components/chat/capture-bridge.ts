// UI 层与 capture 域之间的桥接：每个 HTML 预览面挂一份 usePreviewCaptureActions。
// 组件只感知「动作 + 状态」；帧源实现与编码派发留在 capture 域。
// 截图与录制都抓真实运行的实时预览，不再有静态整页分支。

import { useCallback, useEffect, useRef, useState } from 'react';
import { message } from 'antd';
import type {
  CaptureEncodeSuccess,
  CaptureFormatId,
  CaptureNotice,
  RecordingSettings
} from '../../features/capture';
import {
  downloadCaptureArtifact,
  encodePreviewSource,
  isStillCaptureFormat,
  LivePreviewFrameSource,
  readCapturePreferences
} from '../../features/capture';

// 格式选项与默认格式裁决的事实源在 capture 域（设置页共用），这里只做转发。
export {
  listRecordableAnimationFormats,
  resolveDefaultRecordFormat,
  type RecordFormatOption
} from '../../features/capture';

export type PreviewCaptureKind = 'still' | 'animation';

export interface PreviewCaptureState {
  busy: boolean;
  kind: PreviewCaptureKind | null;
  /** 已请求停止，正在编码已抓到的帧。 */
  stopping: boolean;
  /** 已录制墙钟时间（ms）。 */
  elapsedMs: number;
  capturedFrames: number;
  /** null 表示手动停止模式，没有确定的目标帧数。 */
  totalFrames: number | null;
  /** 截图/编码阶段的文案；录制阶段由 captureProgressText 派生。 */
  progressLabel: string;
}

export interface PreviewCaptureActions {
  state: PreviewCaptureState;
  /** 开始截图/录制；录制停止条件来自全局录制设置。 */
  runFormat: (format: CaptureFormatId) => Promise<void>;
  /** 手动结束录制：保留已抓帧并继续编码。非录制阶段无副作用。 */
  stop: () => void;
}

export interface PreviewCaptureActionsOptions {
  /** 当前预览容器（包含 iframe 的 stage）；实时取景时每次执行都取最新值。 */
  getCaptureTarget: () => HTMLElement | null;
}

const IDLE_STATE: PreviewCaptureState = {
  busy: false,
  kind: null,
  stopping: false,
  elapsedMs: 0,
  capturedFrames: 0,
  totalFrames: null,
  progressLabel: ''
};

/** 录制阶段的按钮/状态文案；组件只消费这里，不自己拼数字。 */
export function captureProgressText(state: PreviewCaptureState): string {
  if (!state.busy) return '';
  if (state.kind === 'still') return state.progressLabel || '正在生成截图…';
  if (state.stopping) return state.progressLabel || '正在完成录制…';
  // 屏幕共享授权/首帧之前显示请求文案，避免用户以为点击没反应。
  if (state.capturedFrames === 0 && state.elapsedMs === 0) {
    return state.progressLabel || '正在录制…';
  }
  const seconds = (Math.max(0, state.elapsedMs) / 1000).toFixed(1);
  const frames = state.totalFrames
    ? `${state.capturedFrames}/${state.totalFrames} 帧`
    : `${state.capturedFrames} 帧`;
  return `正在录制 ${seconds}s · ${frames}`;
}

function formatFps(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/** 成功提示里必须如实报告的限制（帧率不足）。 */
export function captureSuccessNotes(
  result: CaptureEncodeSuccess,
  options: { still: boolean; targetFps?: number }
): string[] {
  const notes: string[] = [];
  const fps = result.effectiveFps;
  if (
    !options.still &&
    typeof fps === 'number' &&
    fps > 0 &&
    typeof options.targetFps === 'number' &&
    fps < options.targetFps * 0.8
  ) {
    notes.push(`实际约 ${formatFps(fps)}fps（目标 ${options.targetFps}fps）`);
  }
  return notes;
}

function announceCaptureSuccess(
  result: CaptureEncodeSuccess,
  context: { still: boolean; targetFps?: number }
): void {
  const label = context.still ? '截图' : '录制';
  const notes = captureSuccessNotes(result, context);
  if (notes.length > 0) {
    message.warning(`${label}已保存 · ${notes.join('；')}`);
  } else {
    message.success(`${label}已保存`);
  }
}

export function usePreviewCaptureActions(options: PreviewCaptureActionsOptions): PreviewCaptureActions {
  const [state, setState] = useState<PreviewCaptureState>(IDLE_STATE);
  const busyRef = useRef(false);
  const cancelRef = useRef<AbortController | null>(null);
  const stopRef = useRef<AbortController | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const finish = useCallback(() => {
    busyRef.current = false;
    cancelRef.current = null;
    stopRef.current = null;
    setState(IDLE_STATE);
  }, []);

  const stop = useCallback(() => {
    const controller = stopRef.current;
    if (!controller || controller.signal.aborted) return;
    controller.abort();
    setState((previous) =>
      previous.busy && previous.kind === 'animation'
        ? { ...previous, stopping: true, progressLabel: '正在完成录制…' }
        : previous
    );
  }, []);

  const runFormat = useCallback(async (format: CaptureFormatId) => {
    if (busyRef.current) return;
    const still = isStillCaptureFormat(format);
    const preferences = readCapturePreferences();
    const recording: RecordingSettings | undefined = still ? undefined : preferences.recording;
    const target = optionsRef.current.getCaptureTarget();
    if (!target) {
      message.error('预览区域不可见，请先打开预览再试');
      return;
    }
    busyRef.current = true;
    const cancelController = new AbortController();
    const stopController = new AbortController();
    cancelRef.current = cancelController;
    stopRef.current = still ? null : stopController;
    setState({
      ...IDLE_STATE,
      busy: true,
      kind: still ? 'still' : 'animation',
      progressLabel: '正在请求屏幕共享…'
    });
    try {
      const callbacks = {
        onPhase: (captured: number, total: number | null, elapsedMs: number) => {
          if (still) return;
          setState((previous) => ({
            ...previous,
            elapsedMs,
            capturedFrames: captured,
            totalFrames: total
          }));
        },
        onEncode: (ratio: number) => {
          setState((previous) => ({
            ...previous,
            stopping: true,
            progressLabel: `正在编码 ${Math.round(ratio * 100)}%…`
          }));
        },
        onNotice: (notice: CaptureNotice) => {
          if (notice === 'duration_limit') {
            message.info('已达到 60 秒录制上限，已保存已抓取的片段');
          } else if (notice === 'memory_limit') {
            message.warning('录制帧数据达到内存上限，已提前结束');
          }
        }
      };
      // 实时取景：getDisplayMedia 必须在点击手势内同步进入（create 的第一条 await）。
      const source = await LivePreviewFrameSource.create({
        target,
        displaySurface: 'browser',
        preferCurrentTab: true,
        frameRate: still ? undefined : recording?.fps
      });
      setState((previous) => ({
        ...previous,
        progressLabel: still ? '正在生成截图…' : '正在录制…'
      }));
      const result = await encodePreviewSource({
        source,
        format,
        recording,
        signal: cancelController.signal,
        stopSignal: still ? undefined : stopController.signal,
        ...callbacks
      });
      if (result.ok) {
        downloadCaptureArtifact(result.artifact);
        announceCaptureSuccess(result, {
          still,
          targetFps: recording?.fps
        });
      } else if (result.failure.code !== 'cancelled') {
        message.error(failureText(result.failure.message));
      }
    } catch (error) {
      message.error(unknownErrorText(error));
    } finally {
      finish();
    }
  }, [finish]);

  useEffect(
    () => () => {
      cancelRef.current?.abort();
      stopRef.current?.abort();
    },
    []
  );

  return { state, runFormat, stop };
}

function failureText(raw: string): string {
  if (raw === 'frame_source_unavailable') return '未抓到可编码的画面，请重试';
  if (raw === 'webm_encoder_unavailable') return '当前浏览器不支持 WebM 录制';
  if (raw === 'webm_encode_empty') return '录制的帧数据为空，请重试';
  if (raw === 'capture_no_frames') return '没有抓到任何帧，请重试';
  return `操作失败：${raw}`;
}

function unknownErrorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const name =
    error && typeof error === 'object' && 'name' in error
      ? String((error as { name?: unknown }).name || '')
      : '';
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
    return '需要允许共享当前标签页，才能录制实时预览';
  }
  if (raw === 'display_capture_unavailable') return '当前浏览器不支持实时预览录制';
  if (raw === 'display_capture_video_failed') return '无法读取屏幕共享画面，请重试';
  if (raw === 'display_capture_target_detached') return '预览区域已关闭，请重试';
  if (raw === 'preview_not_visible') return '请先让预览区域完整显示在屏幕上';
  if (raw === 'Permission denied') return '需要允许共享当前标签页，才能录制实时预览';
  return `操作失败：${raw}`;
}
