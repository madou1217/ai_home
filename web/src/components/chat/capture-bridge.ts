// UI 层与 capture 域之间的桥接：每个 HTML 预览面挂一份 usePreviewCaptureActions。
// 组件只感知「动作 + 状态」；帧源实现与编码派发留在 capture 域。
// still/animation 的两条形状分支是这里仅有的分派点，禁止出现按格式名的分支。

import { useCallback, useEffect, useRef, useState } from 'react';
import { message } from 'antd';
import type { CaptureFormatId, RecordingSettings } from '../../features/capture';
import {
  downloadCaptureArtifact,
  encodePreviewDocument,
  FALLBACK_VIEWPORT_WIDTH,
  isStillCaptureFormat,
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
  /** 当前预览文档（完整 HTML），每次执行时取最新值。 */
  getPreviewDoc: () => string;
  /** 预览视口宽度（与用户实际看到的宽度一致）。 */
  getViewportWidth: () => number;
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
  if (state.kind === 'still') return '正在生成截图…';
  if (state.stopping) return state.progressLabel || '正在完成录制…';
  const seconds = (Math.max(0, state.elapsedMs) / 1000).toFixed(1);
  const frames = state.totalFrames
    ? `${state.capturedFrames}/${state.totalFrames} 帧`
    : `${state.capturedFrames} 帧`;
  return `正在录制 ${seconds}s · ${frames}`;
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
    busyRef.current = true;
    const still = isStillCaptureFormat(format);
    const cancelController = new AbortController();
    const stopController = new AbortController();
    cancelRef.current = cancelController;
    stopRef.current = still ? null : stopController;
    const recording: RecordingSettings | undefined = still
      ? undefined
      : readCapturePreferences().recording;
    setState({
      ...IDLE_STATE,
      busy: true,
      kind: still ? 'still' : 'animation',
      progressLabel: still ? '正在生成截图…' : '正在录制…'
    });
    try {
      const result = await encodePreviewDocument({
        format,
        html: optionsRef.current.getPreviewDoc(),
        width: optionsRef.current.getViewportWidth() || FALLBACK_VIEWPORT_WIDTH,
        recording,
        signal: cancelController.signal,
        stopSignal: still ? undefined : stopController.signal,
        onPhase: (captured, total, elapsedMs) => {
          if (still) return;
          setState((previous) => ({
            ...previous,
            elapsedMs,
            capturedFrames: captured,
            totalFrames: total
          }));
        },
        onEncode: (ratio) => {
          setState((previous) => ({
            ...previous,
            stopping: true,
            progressLabel: `正在编码 ${Math.round(ratio * 100)}%…`
          }));
        },
        onNotice: (notice) => {
          if (notice === 'duration_limit') {
            message.info('已达到 60 秒录制上限，已保存前 60 秒');
          } else if (notice === 'memory_limit') {
            message.warning('录制帧数据达到内存上限，已提前结束');
          }
        }
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
  if (raw === 'frame_source_unavailable') return '预览暂不可截取';
  if (raw === 'webm_encoder_unavailable') return '当前浏览器不支持 WebM 录制';
  if (raw === 'webm_encode_empty') return '录制的帧数据为空，请重试';
  if (raw === 'capture_no_frames') return '没有抓到任何帧，请重试';
  return `操作失败：${raw}`;
}

function unknownErrorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (raw === 'dom_capture_load_timeout') return '预览渲染超时，请重试';
  if (raw === 'dom_capture_load_failed') return '预览克隆失败，请重试';
  return `操作失败：${raw}`;
}
