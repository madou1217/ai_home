// UI 层与 capture 域之间的桥接：每个 HTML 预览面挂一份 usePreviewCaptureActions。
// 组件只感知「动作 + 状态」；帧源实现与编码派发留在 capture 域。
// still/animation 的两条形状分支是这里仅有的分派点，禁止出现按格式名的分支。

import { useCallback, useEffect, useRef, useState } from 'react';
import { message } from 'antd';
import type { CaptureFormatId, RecordingSettings } from '../../features/capture';
import {
  downloadCaptureArtifact,
  encodePreviewDocument,
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
  /** 完整页面模式使用的原始 HTML（与预览 iframe 的 srcdoc 一致）。 */
  getCaptureDocument?: () => string | null;
  /** 完整页面模式的逻辑视口宽度（CSS px）；缺省回退到 target.clientWidth。 */
  getCaptureWidth?: () => number;
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
    const fullPage = preferences.captureScope === 'full';
    const target = optionsRef.current.getCaptureTarget();
    if (!fullPage && !target) {
      message.error('预览区域不可见，请先打开预览再试');
      return;
    }
    if (fullPage && !optionsRef.current.getCaptureDocument) {
      message.error('当前预览不支持完整页面捕获，请切换到实时画面');
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
      progressLabel: fullPage ? '正在渲染完整页面…' : '正在请求屏幕共享…'
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
        onNotice: (notice: 'duration_limit' | 'memory_limit') => {
          if (notice === 'duration_limit') {
            message.info('已达到 60 秒录制上限，已保存已抓取的片段');
          } else if (notice === 'memory_limit') {
            message.warning('录制帧数据达到内存上限，已提前结束');
          }
        }
      };
      const result = fullPage
        ? await (async () => {
            const html = optionsRef.current.getCaptureDocument?.() || '';
            if (!html.trim()) throw new Error('capture_document_unavailable');
            return encodePreviewDocument({
              format,
              html,
              width: Math.round(
                optionsRef.current.getCaptureWidth?.() ?? target?.clientWidth ?? 0
              ),
              recording,
              watermark: preferences.watermark,
              signal: cancelController.signal,
              stopSignal: still ? undefined : stopController.signal,
              ...callbacks
            });
          })()
        : await (async () => {
            // 实时取景：getDisplayMedia 必须在点击手势内同步进入（create 的第一条 await）。
            const source = await LivePreviewFrameSource.create({
              target: target as HTMLElement,
              displaySurface: 'browser',
              preferCurrentTab: true,
              frameRate: still ? undefined : recording?.fps
            });
            setState((previous) => ({
              ...previous,
              progressLabel: still ? '正在生成截图…' : '正在录制…'
            }));
            return encodePreviewSource({
              source,
              format,
              recording,
              watermark: preferences.watermark,
              signal: cancelController.signal,
              stopSignal: still ? undefined : stopController.signal,
              ...callbacks
            });
          })();
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
  if (raw === 'dom_capture_requires_window') return '当前环境不支持完整页面渲染，请切换到实时画面';
  if (raw === 'dom_capture_load_timeout') return '预览渲染超时，请重试';
  if (raw === 'dom_capture_load_failed') return '预览克隆失败，请重试';
  if (raw === 'capture_document_unavailable') return '无法读取预览文档，请重新打开预览';
  return `操作失败：${raw}`;
}
