// HTML 预览弹窗（blob 独立文档）与宿主应用之间的捕获桥（宿主侧）。
//
// 弹窗文档拿不到主 bundle：它拿到屏幕共享流后通过 postMessage 通知宿主，
// 宿主读取弹窗里的 video 抓帧并编码，再把 blob URL 回传触发下载。
// 截图与录制都走实时画面，没有静态整页路径。

import type { CaptureFormatId, CaptureNotice, StillCaptureFormatId } from './types';
import type { CapturePreferences } from './capture-preferences';
import { encodePreviewSource } from './preview-encode-dispatch';
import { PopupWindowFrameSource } from './popup-window-frame-source';
import {
  isFormatAvailable,
  probeCaptureFormatAvailability,
  type CaptureFormatAvailability
} from './format-availability';
import { readCapturePreferences } from './capture-preferences';
import { listAnimationFormats, listStillFormats } from './format-catalog';

/** 消息类型标记：命名空间常量，弹窗脚本与宿主各自遵守同一契约。 */
export const CAPTURE_RESULT_TYPE = 'aih:html-preview-capture-result';
export const CAPTURE_CANCEL_TYPE = 'aih:html-preview-capture-cancel';
/** 弹窗已拿到屏幕共享流并挂到隐藏 video 上，宿主可以开始实时抓帧。 */
export const CAPTURE_STREAM_READY_TYPE = 'aih:html-preview-capture-stream-ready';

export type CaptureWindowRequestKind = 'still' | 'record';
export type CaptureWindowProgressPhase = 'capturing' | 'encoding';

export interface CaptureWindowStreamReady {
  type: typeof CAPTURE_STREAM_READY_TYPE;
  requestId: string;
  kind: CaptureWindowRequestKind;
  /** 省略时由宿主按偏好解析。 */
  format?: string;
  /** 弹窗是否已用 Region Capture 把视频轨裁到预览元素。 */
  cropped: boolean;
}

/** 弹窗 → 宿主：结束当前录制（保留已抓帧并继续编码）。 */
export interface CaptureWindowCancel {
  type: typeof CAPTURE_CANCEL_TYPE;
  requestId: string;
}

interface CaptureWindowProgress {
  type: typeof CAPTURE_RESULT_TYPE;
  requestId: string;
  kind: 'progress';
  label: string;
  phase?: CaptureWindowProgressPhase;
}

export interface CaptureWindowSuccess {
  type: typeof CAPTURE_RESULT_TYPE;
  requestId: string;
  kind: 'artifact';
  ok: true;
  url: string;
  fileName: string;
  /** 产物不完整/提前结束的真实原因。 */
  notice?: CaptureNotice;
  /** 动画录制的实际抓帧速率（帧/秒）。 */
  effectiveFps?: number;
  /** 本次录制的目标帧率，用于判断实际帧率是否明显偏低。 */
  targetFps?: number;
}

export interface CaptureWindowFailure {
  type: typeof CAPTURE_RESULT_TYPE;
  requestId: string;
  kind: 'artifact';
  ok: false;
  message: string;
}

export type CaptureWindowReply = CaptureWindowProgress | CaptureWindowSuccess | CaptureWindowFailure;

/** 产物 URL 的回收延迟（给浏览器下载器留出点击时间）。 */
const ARTIFACT_URL_REVOKE_DELAY_MS = 60_000;

/** 最小回传接口（宿主窗口与弹窗 iframe 都满足，测试用 stub 也好写）。 */
export interface CaptureReplyTarget {
  postMessage: (message: unknown, targetOrigin: string) => void;
}

export interface ResolveRequestFormatDeps {
  preferences?: CapturePreferences;
  availability?: CaptureFormatAvailability;
}

/** 静图请求只接受静图格式；未知或动画格式一律回退 PNG。 */
function resolveStillFormat(format: string | undefined): StillCaptureFormatId {
  if (!format) return 'png';
  const known = listStillFormats().some((item) => item.id === format);
  return known ? (format as StillCaptureFormatId) : 'png';
}

/** 解析弹窗请求的最终格式；解析不出可用格式时返回 null。 */
export function resolveRequestFormat(
  request: Pick<CaptureWindowStreamReady, 'kind' | 'format'>,
  deps: ResolveRequestFormatDeps = {}
): CaptureFormatId | null {
  const availability = deps.availability ?? probeCaptureFormatAvailability();
  const prefs = deps.preferences ?? readCapturePreferences();
  if (request.kind === 'still') return resolveStillFormat(request.format);
  // record：可选清单 = 启用矩阵 ∩ 浏览器能力；显式格式与偏好默认格式都必须落在清单内。
  const options = listAnimationFormats().filter(
    (format) => prefs.enabledFormats[format.id] !== false && isFormatAvailable(format.id, availability)
  );
  if (request.format && options.some((option) => option.id === request.format)) {
    return request.format as CaptureFormatId;
  }
  if (options.some((option) => option.id === prefs.defaultFormat)) return prefs.defaultFormat;
  return options[0]?.id ?? null;
}

/** 判定消息是否为「实时流已就绪」（形状校验，来源校验在接线层）。 */
export function isCaptureWindowStreamReady(data: unknown): data is CaptureWindowStreamReady {
  if (typeof data !== 'object' || data === null) return false;
  const candidate = data as Partial<CaptureWindowStreamReady>;
  if (candidate.type !== CAPTURE_STREAM_READY_TYPE) return false;
  if (typeof candidate.requestId !== 'string' || candidate.requestId.length === 0) return false;
  if (candidate.kind !== 'still' && candidate.kind !== 'record') return false;
  if (candidate.format !== undefined && typeof candidate.format !== 'string') return false;
  return typeof candidate.cropped === 'boolean';
}

/** 判定消息是否为「停止录制」请求（形状校验，来源校验在接线层）。 */
export function isCaptureWindowCancel(data: unknown): data is CaptureWindowCancel {
  if (typeof data !== 'object' || data === null) return false;
  const candidate = data as Partial<CaptureWindowCancel>;
  return (
    candidate.type === CAPTURE_CANCEL_TYPE &&
    typeof candidate.requestId === 'string' &&
    candidate.requestId.length > 0
  );
}

export interface CaptureWindowRequestHooks {
  onProgress?: (label: string, phase?: CaptureWindowProgressPhase) => void;
  /** 手动停止：停止抓帧后继续编码已抓到的帧。 */
  stopSignal?: AbortSignal;
}

type WindowCaptureResult = Awaited<ReturnType<typeof encodePreviewSource>>;

/** 把捕获域/弹窗桥的内部错误码收敛成用户可读文案。 */
function friendlyCaptureError(message: string): string {
  if (message === 'popup_capture_unavailable') return '无法读取预览窗口，请重试';
  if (message === 'popup_capture_video_missing') return '没有找到屏幕共享画面，请重试';
  if (message === 'popup_capture_target_missing') return '预览区域已关闭';
  if (message === 'popup_capture_target_not_visible') return '请先让预览完整显示在屏幕上';
  if (message === 'popup_capture_video_not_ready') return '屏幕共享画面未就绪，请重试';
  if (message === 'popup_capture_video_failed') return '屏幕共享画面读取失败，请重试';
  if (message === 'popup_capture_crop_not_ready') return '屏幕共享画面还未裁切到预览区域，请重试';
  if (message === 'frame_source_unavailable') return '未抓到可编码的画面，请重试';
  if (message === 'capture_format_unavailable') return '没有可用的录制格式';
  if (message === 'capture_no_frames') return '没有抓到任何帧，请重试';
  if (message === 'webm_encoder_unavailable') return '当前浏览器不支持 WebM 录制';
  if (message === 'webm_encode_empty') return '录制的帧数据为空，请重试';
  if (message === 'Permission denied' || message === 'NotAllowedError') {
    return '需要允许共享当前预览窗口';
  }
  return message;
}

function toCaptureWindowReply(
  result: WindowCaptureResult,
  requestId: string,
  targetFps?: number
): CaptureWindowSuccess | CaptureWindowFailure {
  if (!result.ok) {
    return {
      type: CAPTURE_RESULT_TYPE,
      requestId,
      kind: 'artifact',
      ok: false,
      message: friendlyCaptureError(result.failure.message)
    };
  }
  const url = URL.createObjectURL(result.artifact.blob);
  window.setTimeout(() => URL.revokeObjectURL(url), ARTIFACT_URL_REVOKE_DELAY_MS);
  return {
    type: CAPTURE_RESULT_TYPE,
    requestId,
    kind: 'artifact',
    ok: true,
    url,
    fileName: result.artifact.suggestedFileName,
    notice: result.notice,
    effectiveFps: result.effectiveFps,
    targetFps
  };
}

function progressReporter(
  onProgress?: (label: string, phase?: CaptureWindowProgressPhase) => void
) {
  return {
    onPhase: (captured: number, total: number | null, elapsedMs: number) => {
      const seconds = (Math.max(0, elapsedMs) / 1000).toFixed(1);
      const frames = total ? `${captured}/${total}` : `${captured}`;
      onProgress?.(`正在录制 ${seconds}s（${frames} 帧）`, 'capturing');
    },
    onEncode: (ratio: number) =>
      onProgress?.(`正在编码 ${Math.round(ratio * 100)}%…`, 'encoding')
  };
}

/** 弹窗实时流：宿主读取弹窗里的屏幕共享 video，按预览区域裁切后编码。 */
export async function runCaptureForWindowStream(
  request: CaptureWindowStreamReady,
  sourceWindow: Window,
  hooks: CaptureWindowRequestHooks = {}
): Promise<CaptureWindowSuccess | CaptureWindowFailure> {
  const fail = (message: string): CaptureWindowFailure => ({
    type: CAPTURE_RESULT_TYPE,
    requestId: request.requestId,
    kind: 'artifact',
    ok: false,
    message: friendlyCaptureError(message)
  });
  const preferences = readCapturePreferences();
  const format = resolveRequestFormat(request, { preferences });
  if (!format) return fail('capture_format_unavailable');
  const controller = new AbortController();
  try {
    const source = await PopupWindowFrameSource.create(sourceWindow, {
      cropped: request.cropped
    });
    const result = await encodePreviewSource({
      source,
      format,
      recording: preferences.recording,
      signal: controller.signal,
      stopSignal: hooks.stopSignal,
      ...progressReporter(hooks.onProgress)
    });
    return toCaptureWindowReply(
      result,
      request.requestId,
      request.kind === 'record' ? preferences.recording.fps : undefined
    );
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

/** 安装弹窗捕获宿主。只应答同源（blob 文档继承当前 origin）。返回解绑函数。 */
export function installPreviewWindowCaptureHost(target: Window = window): () => void {
  /** requestId → 停止控制器；弹窗的「停止」消息命中后只结束抓帧，编码继续。 */
  const stopControllers = new Map<string, AbortController>();
  const listener = async (event: MessageEvent) => {
    if (event.origin !== target.location.origin) return;
    if (isCaptureWindowCancel(event.data)) {
      stopControllers.get(event.data.requestId)?.abort();
      return;
    }
    const sourceWindow = event.source as (Window & CaptureReplyTarget) | null;
    if (!sourceWindow || typeof sourceWindow.postMessage !== 'function') return;
    const reply = (payload: CaptureWindowReply) => sourceWindow.postMessage(payload, '*');
    if (isCaptureWindowStreamReady(event.data)) {
      const request = event.data;
      const stopController = new AbortController();
      stopControllers.set(request.requestId, stopController);
      reply({
        type: CAPTURE_RESULT_TYPE,
        requestId: request.requestId,
        kind: 'progress',
        label: request.kind === 'still' ? '正在生成截图…' : '正在捕获…'
      });
      try {
        const result = await runCaptureForWindowStream(request, sourceWindow, {
          stopSignal: stopController.signal,
          onProgress: (label, phase) =>
            reply({ type: CAPTURE_RESULT_TYPE, requestId: request.requestId, kind: 'progress', label, phase })
        });
        reply(result);
      } finally {
        stopControllers.delete(request.requestId);
      }
    }
  };
  target.addEventListener('message', listener);
  return () => target.removeEventListener('message', listener);
}

let captureHostInstalled = false;

/** 打开弹窗前调用：首次打开时安装宿主（幂等，不重复挂监听）。 */
export function ensurePreviewWindowCaptureHost(): void {
  if (captureHostInstalled || typeof window === 'undefined') return;
  installPreviewWindowCaptureHost();
  captureHostInstalled = true;
}
