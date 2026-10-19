// HTML 预览弹窗（blob 独立文档）与宿主应用之间的捕获桥（宿主侧）。
//
// 弹窗文档拿不到主 bundle：它通过 postMessage 把「待捕获文档 + 视口宽」投回
// 宿主（同一 origin），宿主复用 encodePreviewDocument 完成栅格化与编码，
// 再把 blob URL 回传给弹窗触发下载。捕获逻辑零复制，单测不打 postMessage。

import type { CaptureFormatId, CapturePreferences, StillCaptureFormatId } from './types';
import { encodePreviewDocument } from './preview-encode-dispatch';
import {
  isFormatAvailable,
  probeCaptureFormatAvailability,
  type CaptureFormatAvailability
} from './format-availability';
import { readCapturePreferences } from './capture-preferences';
import { listAnimationFormats, listStillFormats } from './format-catalog';

/** 消息类型标记：命名空间常量，弹窗脚本与宿主各自遵守同一契约。 */
export const CAPTURE_REQUEST_TYPE = 'aih:html-preview-capture-request';
export const CAPTURE_RESULT_TYPE = 'aih:html-preview-capture-result';

export type CaptureWindowRequestKind = 'still' | 'record';

export interface CaptureWindowRequest {
  type: typeof CAPTURE_REQUEST_TYPE;
  requestId: string;
  kind: CaptureWindowRequestKind;
  /** 省略时：still → png；record → 偏好默认录制格式。 */
  format?: string;
  html: string;
  width: number;
}

interface CaptureWindowProgress {
  type: typeof CAPTURE_RESULT_TYPE;
  requestId: string;
  kind: 'progress';
  label: string;
}

export interface CaptureWindowSuccess {
  type: typeof CAPTURE_RESULT_TYPE;
  requestId: string;
  kind: 'artifact';
  ok: true;
  url: string;
  fileName: string;
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
  request: Pick<CaptureWindowRequest, 'kind' | 'format'>,
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

/** 判定消息是否为捕获请求（形状校验，来源校验在接线层）。 */
export function isCaptureWindowRequest(data: unknown): data is CaptureWindowRequest {
  if (typeof data !== 'object' || data === null) return false;
  const candidate = data as Partial<CaptureWindowRequest>;
  if (candidate.type !== CAPTURE_REQUEST_TYPE) return false;
  if (typeof candidate.requestId !== 'string' || candidate.requestId.length === 0) return false;
  if (candidate.kind !== 'still' && candidate.kind !== 'record') return false;
  return typeof candidate.html === 'string' && candidate.html.length > 0;
}

export interface CaptureWindowRequestHooks {
  onProgress?: (label: string) => void;
}

/** 执行一次捕获并返回回传载荷（不碰 postMessage，方便单测）。 */
export async function runCaptureForWindowRequest(
  request: CaptureWindowRequest,
  hooks: CaptureWindowRequestHooks = {}
): Promise<CaptureWindowSuccess | CaptureWindowFailure> {
  const fail = (message: string): CaptureWindowFailure => ({
    type: CAPTURE_RESULT_TYPE,
    requestId: request.requestId,
    kind: 'artifact',
    ok: false,
    message
  });
  const format = resolveRequestFormat(request);
  if (!format) return fail('capture_format_unavailable');
  const controller = new AbortController();
  try {
    const result = await encodePreviewDocument({
      format,
      html: request.html,
      width: request.width || 720,
      signal: controller.signal,
      onPhase: (captured, total) => hooks.onProgress?.(`正在抓帧 ${captured}/${total}…`),
      onEncode: (ratio) => hooks.onProgress?.(`正在编码 ${Math.round(ratio * 100)}%…`)
    });
    if (!result.ok) return fail(result.failure.message);
    const url = URL.createObjectURL(result.artifact.blob);
    window.setTimeout(() => URL.revokeObjectURL(url), ARTIFACT_URL_REVOKE_DELAY_MS);
    return {
      type: CAPTURE_RESULT_TYPE,
      requestId: request.requestId,
      kind: 'artifact',
      ok: true,
      url,
      fileName: result.artifact.fileName
    };
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

/** 安装弹窗捕获宿主。只应答同源（blob 文档继承当前 origin）。返回解绑函数。 */
export function installPreviewWindowCaptureHost(target: Window = window): () => void {
  const listener = async (event: MessageEvent) => {
    if (!isCaptureWindowRequest(event.data)) return;
    if (event.origin !== target.location.origin) return;
    const source = event.source as CaptureReplyTarget | null;
    if (!source || typeof source.postMessage !== 'function') return;
    const request = event.data as CaptureWindowRequest;
    const reply = (payload: CaptureWindowReply) => source.postMessage(payload, '*');
    reply({ type: CAPTURE_RESULT_TYPE, requestId: request.requestId, kind: 'progress', label: '正在捕获…' });
    const result = await runCaptureForWindowRequest(request, {
      onProgress: (label) => reply({ type: CAPTURE_RESULT_TYPE, requestId: request.requestId, kind: 'progress', label })
    });
    reply(result);
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
