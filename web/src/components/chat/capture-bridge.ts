// UI 层与 capture 域之间的桥接：每个 HTML 预览面挂一份 usePreviewCaptureActions。
// 组件只感知「动作 + 状态」；帧源实现与编码派发留在 capture 域。
// still/animation 的两条形状分支是这里仅有的分派点，禁止出现按格式名的分支。

import { useCallback, useEffect, useRef, useState } from 'react';
import { message } from 'antd';
import type { CaptureFormatId } from '../../features/capture';
import {
  downloadCaptureArtifact,
  encodePreviewDocument,
  FALLBACK_VIEWPORT_WIDTH,
  isStillCaptureFormat
} from '../../features/capture';

// 格式选项与默认格式裁决的事实源在 capture 域（设置页共用），这里只做转发。
export {
  listRecordableAnimationFormats,
  resolveDefaultRecordFormat,
  type RecordFormatOption
} from '../../features/capture';

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
      const result = await encodePreviewDocument({
        format,
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
