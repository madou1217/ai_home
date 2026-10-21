import {
  ensurePreviewWindowCaptureHost,
  readCapturePreferences,
  summarizeRecordingSettings,
  type CapturePreviewDevice,
  type CaptureWatermarkIdentity
} from '../../features/capture';

export type HtmlPreviewDevice = CapturePreviewDevice;

export interface HtmlPreviewAutoCapture {
  kind: 'still' | 'record';
  /** 录制格式；省略时由宿主按全局偏好解析。 */
  format?: string;
}

export interface HtmlPreviewWindowOptions {
  device: HtmlPreviewDevice;
  title?: string;
  /** 录制条件摘要；省略时读取全局录制设置。 */
  recordingHint?: string;
  /** 打开弹窗时所处会话的 provider/model；捕获水印使用。 */
  captureIdentity?: CaptureWatermarkIdentity;
  /** 页面渲染完成后自动进入捕获流程（主要用于从会话内跳转录制）。 */
  autoCapture?: HtmlPreviewAutoCapture;
}

export interface PopupCaptureSettings {
  fps: number;
}

/** Chrome capability delegation：把一次用户手势授权转交给新弹窗。 */
type CapabilityDelegatingPostMessage = (
  message: unknown,
  targetOrigin: string,
  options?: { delegate?: string }
) => void;

/**
 * 弹窗点击捕获时的帧率解析（纯函数）。
 *
 * 弹窗文档在打开时就把脚本写死了，如果沿用构建期快照，用户之后在设置页改的
 * 帧率不会生效。这里允许把函数体原样注入弹窗脚本（toString），
 * 因此它必须自包含：不能引用模块里的其它常量或函数。
 */
export function parsePopupCaptureSettings(
  raw: string | null | undefined,
  fallbackFps = 30
): PopupCaptureSettings {
  const options = [10, 15, 24, 30, 60];
  const nearest = (value: number) => {
    let chosen = options[0];
    let smallest = Number.POSITIVE_INFINITY;
    for (const option of options) {
      const delta = Math.abs(option - value);
      if (delta < smallest || (delta === smallest && option > chosen)) {
        chosen = option;
        smallest = delta;
      }
    }
    return chosen;
  };
  const safeFallback =
    typeof fallbackFps === 'number' && Number.isFinite(fallbackFps) && fallbackFps > 0
      ? nearest(fallbackFps)
      : 30;
  if (!raw) return { fps: safeFallback };
  try {
    const value = JSON.parse(raw) as { recording?: { fps?: unknown } };
    const recordedFps = value?.recording?.fps;
    return {
      fps:
        typeof recordedFps === 'number' && Number.isFinite(recordedFps) && recordedFps > 0
          ? nearest(recordedFps)
          : safeFallback
    };
  } catch {
    return { fps: safeFallback };
  }
}

const HTML_PREVIEW_SANDBOX = 'allow-scripts allow-forms allow-modals allow-popups allow-downloads';
const PREVIEW_URL_REVOKE_DELAY_MS = 60_000;

/** 与宿主 preview-window-host.ts 约定的消息契约（弹窗侧不能 import，保持常量同步）。 */
const CAPTURE_RESULT_TYPE = 'aih:html-preview-capture-result';
const CAPTURE_CANCEL_TYPE = 'aih:html-preview-capture-cancel';
const CAPTURE_STREAM_READY_TYPE = 'aih:html-preview-capture-stream-ready';
/** 宿主在打开弹窗时用 capability delegation 授权弹窗立即调用 getDisplayMedia。 */
const CAPTURE_AUTO_START_TYPE = 'aih:html-preview-capture-auto-start';

function escapeHtml(value: string) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeHtmlAttribute(value: string) {
  return escapeHtml(value)
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** JSON 字符串嵌入 <script> 时转义 "<"，避免内容提前闭合脚本标签。 */
function jsonForScript(value: string) {
  return JSON.stringify(String(value || '')).replace(/</g, '\\u003c');
}

export function buildHtmlPreviewWindowDocument(
  documentContent: string,
  options: HtmlPreviewWindowOptions
) {
  const initialDevice = options.device === 'mobile' ? 'mobile' : 'desktop';
  const rawTitle = options.title || 'HTML 预览';
  const title = escapeHtml(rawTitle);
  const titleAttribute = escapeHtmlAttribute(rawTitle);
  const srcDoc = escapeHtmlAttribute(documentContent);
  const preferences = readCapturePreferences();
  const recordingHint = escapeHtml(
    options.recordingHint ?? summarizeRecordingSettings(preferences.recording)
  );
  const recordingFps = Number(preferences?.recording?.fps);
  const fallbackFps = Number.isFinite(recordingFps)
    ? Math.max(1, Math.min(60, Math.round(recordingFps)))
    : 30;
  const captureProvider = options.captureIdentity?.provider || '';
  const captureModel = options.captureIdentity?.model || '';
  const autoCaptureKind =
    options.autoCapture?.kind === 'still' || options.autoCapture?.kind === 'record'
      ? options.autoCapture.kind
      : '';
  const autoCaptureFormat = options.autoCapture?.format || '';

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>
    /* 独立 blob 页面拿不到应用的 CSS 变量：这里内联深色 Cyber HUD 取值（design-tokens.css [data-theme='dark']）。 */
    :root { color-scheme: dark; font-family: "JetBrains Mono", "SF Mono", ui-monospace, Menlo, Consolas, "PingFang SC", monospace; }
    * { box-sizing: border-box; }
    html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; }
    body { display: flex; flex-direction: column; background: #05080e; color: #e2f1f8; }
    .toolbar { min-height: 56px; padding: 10px 16px; display: flex; align-items: center; justify-content: space-between; gap: 16px; border-bottom: 1px solid rgba(0, 240, 255, .35); background: #0a101a; box-shadow: 0 0 18px rgba(0, 240, 255, .12); }
    .identity { min-width: 0; display: flex; align-items: center; gap: 10px; }
    .signal { width: 6px; height: 6px; flex: 0 0 auto; border-radius: 50%; background: #00ff66; box-shadow: 0 0 6px #00ff66; }
    .title { overflow: hidden; color: #f2fbff; font-size: 13px; font-weight: 700; letter-spacing: .02em; text-overflow: ellipsis; white-space: nowrap; }
    .subtitle { color: #5c7890; font-size: 10px; font-weight: 600; letter-spacing: .12em; text-transform: uppercase; }
    .controls, .devices { display: flex; align-items: center; gap: 6px; }
    .controls { flex-wrap: wrap; justify-content: flex-end; }
    .device { min-height: 32px; padding: 5px 12px; border: 1px solid #15263d; border-radius: 0; background: #03060b; color: #7f9bb3; font: inherit; font-size: 12px; font-weight: 600; letter-spacing: .04em; cursor: pointer; transition: background-color 120ms, border-color 120ms, color 120ms, box-shadow 120ms; }
    .capture { min-height: 32px; padding: 5px 12px; border: 1px solid #23405f; border-radius: 0; background: #0c1524; color: #e2f1f8; font: inherit; font-size: 12px; font-weight: 600; letter-spacing: .04em; cursor: pointer; transition: background-color 120ms, border-color 120ms, color 120ms; }
    .capture:hover { border-color: #00f0ff; color: #00f0ff; background: rgba(0, 240, 255, .08); }
    .capture:disabled { opacity: .65; cursor: default; }
    .capture.is-recording { border-color: #ff5c7a; color: #ff8fa3; background: rgba(255, 92, 122, .12); }
    .capture.is-recording:hover { border-color: #ff8fa3; color: #ffb3c0; background: rgba(255, 92, 122, .2); }
    .capture.is-auto-ready { border-color: #00ff66; color: #00ff66; background: rgba(0, 255, 102, .1); animation: capture-ready-pulse 1.4s ease-in-out infinite; }
    .capture.is-auto-ready:hover { border-color: #7dffae; color: #7dffae; background: rgba(0, 255, 102, .18); }
    @keyframes capture-ready-pulse {
      0%, 100% { box-shadow: 0 0 0 rgba(0, 255, 102, 0); }
      50% { box-shadow: 0 0 18px rgba(0, 255, 102, .35); }
    }
    @media (prefers-reduced-motion: reduce) {
      .capture.is-auto-ready { animation: none; }
    }
    .capture-hint { color: #5c7890; font-size: 11px; font-weight: 600; letter-spacing: .04em; white-space: nowrap; }
    .capture-status { display: inline-flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 8px; max-width: 420px; color: #5c7890; font-size: 11px; font-weight: 600; line-height: 1.5; letter-spacing: .04em; text-align: right; }
    .capture-status[hidden] { display: none; }
    .status-action { flex: 0 0 auto; min-height: 26px; padding: 2px 8px; border: 1px solid #23405f; border-radius: 0; background: #0c1524; color: #e2f1f8; font: inherit; font-size: 11px; font-weight: 600; cursor: pointer; }
    .status-action:hover { border-color: #00f0ff; color: #00f0ff; background: rgba(0, 240, 255, .08); }
    .device:hover { border-color: rgba(0, 240, 255, .55); color: #00f0ff; }
    .device[aria-pressed="true"] { border-color: #00f0ff; background: rgba(0, 240, 255, .14); color: #00f0ff; box-shadow: 0 0 18px rgba(0, 240, 255, .25); text-shadow: 0 0 10px rgba(0, 240, 255, .55); }
    .fullscreen { min-height: 32px; padding: 5px 12px; border: 1px solid #23405f; border-radius: 0; background: #0c1524; color: #e2f1f8; font: inherit; font-size: 12px; font-weight: 600; letter-spacing: .04em; cursor: pointer; transition: background-color 120ms, border-color 120ms, color 120ms; }
    .fullscreen:hover { border-color: #00f0ff; color: #00f0ff; background: rgba(0, 240, 255, .08); }
    .fullscreen[hidden] { display: none; }
    .stage { flex: 1; min-height: 0; padding: 16px; display: flex; align-items: center; justify-content: center; overflow: auto; background-color: #05080e; background-image: linear-gradient(rgba(0, 240, 255, .035) 1px, transparent 1px), linear-gradient(90deg, rgba(0, 240, 255, .035) 1px, transparent 1px); background-size: 32px 32px; }
    .preview { display: block; border: 1px solid rgba(0, 240, 255, .35); background: #fff; transition: width 160ms cubic-bezier(0.2, 0, 0, 1), height 160ms cubic-bezier(0.2, 0, 0, 1), border-radius 160ms cubic-bezier(0.2, 0, 0, 1); }
    .preview:fullscreen { width: 100%; height: 100%; border: 0; border-radius: 0; box-shadow: none; }
    .stage[data-device="desktop"] .preview { width: 100%; height: 100%; border-radius: 0; box-shadow: 0 0 18px rgba(0, 240, 255, .12); }
    /* 手机视口保留设备外框圆角（模拟真机屏幕边界），外框用 HUD 发丝线 + 辉光 */
    .stage[data-device="mobile"] .preview { width: min(390px, calc(100vw - 24px)); height: min(844px, calc(100vh - 96px)); border-width: 8px; border-color: #0c1524; border-radius: 30px; box-shadow: 0 0 0 1px rgba(0, 240, 255, .35), 0 0 30px rgba(0, 240, 255, .12); }
    @media (max-width: 560px) {
      .toolbar { align-items: flex-start; flex-direction: column; gap: 8px; }
      .controls, .devices { width: 100%; }
      .controls { align-items: stretch; }
      .device { flex: 1; }
      .fullscreen { flex: 0 0 auto; }
      .stage { padding: 8px; }
      .stage[data-device="mobile"] .preview { height: calc(100vh - 122px); }
    }
  </style>
</head>
<body>
  <header class="toolbar">
    <div class="identity">
      <span class="signal" aria-hidden="true"></span>
      <div>
        <div class="title">${title}</div>
        <div class="subtitle">Isolated HTML preview</div>
      </div>
    </div>
    <div class="controls">
      <div class="devices" role="group" aria-label="预览设备">
        <button class="device" type="button" data-device-option="desktop" aria-pressed="${initialDevice === 'desktop'}">PC 预览</button>
        <button class="device" type="button" data-device-option="mobile" aria-pressed="${initialDevice === 'mobile'}">手机预览</button>
      </div>
      <button class="fullscreen" type="button" data-fullscreen${initialDevice === 'mobile' ? ' hidden' : ''}>全屏</button>
      <span class="capture-hint" data-recording-hint>${recordingHint}</span>
      <button class="capture" type="button" data-capture="screenshot">截图</button>
      <button class="capture" type="button" data-capture="record">录制</button>
      <span class="capture-status" data-capture-status hidden></span>
    </div>
  </header>
  <main class="stage" data-preview-stage data-device="${initialDevice}">
    <iframe id="aih-preview-target" class="preview" title="${titleAttribute}" sandbox="${HTML_PREVIEW_SANDBOX}" referrerpolicy="no-referrer" srcdoc="${srcDoc}"></iframe>
  </main>
  <script>
    const stage = document.querySelector('[data-preview-stage]');
    const preview = document.querySelector('.preview');
    const fullscreen = document.querySelector('[data-fullscreen]');
    document.querySelectorAll('[data-device-option]').forEach((button) => {
      button.addEventListener('click', () => {
        stage.dataset.device = button.dataset.deviceOption;
        fullscreen.hidden = button.dataset.deviceOption !== 'desktop';
        document.querySelectorAll('[data-device-option]').forEach((option) => {
          option.setAttribute('aria-pressed', String(option === button));
        });
      });
    });
    fullscreen.addEventListener('click', async () => {
      if (typeof preview.requestFullscreen !== 'function') return;
      try {
        await preview.requestFullscreen();
      } catch (_error) {
        // 浏览器拒绝全屏时保留普通 PC 预览，不影响页面交互。
      }
    });

    // 捕获桥（弹窗侧）：截图与录制都只抓实时画面，保留脚本、Canvas/WebGL
    // 与鼠标交互；不再重新渲染静态整页。
    const status = document.querySelector('[data-capture-status]');
    const recordButton = document.querySelector('[data-capture="record"]');
    const shotButton = document.querySelector('[data-capture="screenshot"]');
    const captureButtons = [shotButton, recordButton];
    const CAPTURE_TIMEOUT_MS = 300000;
    const CAPTURE_VIDEO_ID = 'aih-capture-video';
    const CAPTURE_PREFS_KEY = 'aih.capture';
    const FALLBACK_CAPTURE_FPS = ${fallbackFps};
    const CAPTURE_PROVIDER = ${jsonForScript(captureProvider)};
    const CAPTURE_MODEL = ${jsonForScript(captureModel)};
    const AUTO_CAPTURE_KIND = ${jsonForScript(autoCaptureKind)};
    const AUTO_CAPTURE_FORMAT = ${jsonForScript(autoCaptureFormat)};
    const AUTO_CAPTURE_START_TYPE = '${CAPTURE_AUTO_START_TYPE}';
    const PREVIEW_READY_TIMEOUT_MS = 4000;
    const CAPTURE_STABILITY_TIMEOUT_MS = 2500;
    const CAPTURE_STABILITY_TOLERANCE = 0.04;
    // 点击时重新解析偏好：弹窗打开后用户在设置页的修改也要立即生效。
    const readLiveCaptureSettings = ${parsePopupCaptureSettings.toString()};
    let captureSeq = 0;
    let pendingRequest = '';
    let pendingTimer = 0;
    let phase = 'idle';
    let activeStream = null;
    let activeVideo = null;
    let previewLoaded = false;
    let previewReadyResolved = false;
    let previewReadyResolve = null;
    const previewReady = new Promise(function(resolve) {
      previewReadyResolve = resolve;
    });
    let autoCapturePending = AUTO_CAPTURE_KIND !== '';

    function readCapturePreferencesRaw() {
      try {
        return window.localStorage.getItem(CAPTURE_PREFS_KEY);
      } catch (_error) {
        return null;
      }
    }
    function currentCaptureSettings() {
      return readLiveCaptureSettings(
        readCapturePreferencesRaw(),
        FALLBACK_CAPTURE_FPS
      );
    }
    function formatFps(value) {
      const rounded = Math.round(value * 10) / 10;
      return rounded === Math.round(rounded) ? String(Math.round(rounded)) : rounded.toFixed(1);
    }
    function showStatus(label) {
      status.textContent = label;
      status.hidden = false;
    }
    function setPhase(next, label) {
      phase = next;
      recordButton.textContent =
        next === 'recording' ? '停止' : next === 'requesting' ? '请求中…' : '录制';
      recordButton.classList.toggle('is-recording', next === 'recording');
      if (next !== 'idle') {
        recordButton.classList.remove('is-auto-ready');
        shotButton.classList.remove('is-auto-ready');
      }
      recordButton.setAttribute('aria-pressed', String(next === 'recording'));
      recordButton.disabled = next === 'requesting' || next === 'finishing';
      shotButton.disabled = next !== 'idle';
      if (label) showStatus(label);
      else if (next === 'idle') {
        status.hidden = true;
        status.textContent = '';
      }
    }
    function resolvePreviewReady() {
      if (previewReadyResolved) return;
      previewReadyResolved = true;
      if (previewReadyResolve) previewReadyResolve();
    }
    function markPreviewLoaded() {
      if (previewLoaded) return;
      previewLoaded = true;
      // iframe load 只代表资源结束；再等一个短任务让首屏布局/尺寸稳定，
      // 之后才开始 Region Capture 裁切。
      window.setTimeout(function() {
        resolvePreviewReady();
        maybeAutoCapture();
      }, 160);
    }
    function showAutoReadyPrompt() {
      const label = AUTO_CAPTURE_KIND === 'still' ? '截图' : '录制';
      const actionButton = AUTO_CAPTURE_KIND === 'still' ? shotButton : recordButton;
      setPhase('idle', '页面已渲染完成 · 点击「' + label + '」开始');
      actionButton.classList.add('is-auto-ready');
      try {
        actionButton.focus({ preventScroll: true });
      } catch (_error) {}
    }
    function maybeAutoCapture() {
      if (!previewLoaded || !autoCapturePending) return;
      autoCapturePending = false;
      const activation = navigator.userActivation;
      // 没有能力委托时，浏览器不允许弹窗在没有手势的情况下调用
      // getDisplayMedia。给出明确的一键入口，而不是静默失败。
      if (!activation || activation.isActive !== true) {
        showAutoReadyPrompt();
        return;
      }
      startLiveCapture(
        AUTO_CAPTURE_KIND,
        currentCaptureSettings().fps,
        AUTO_CAPTURE_FORMAT || undefined,
        true
      );
    }
    function handleDelegatedAutoStart(data) {
      if (phase !== 'idle') return;
      const kind = data && data.kind === 'still' ? 'still' : 'record';
      const format =
        data && typeof data.format === 'string' && data.format
          ? data.format
          : AUTO_CAPTURE_FORMAT || undefined;
      autoCapturePending = false;
      recordButton.classList.remove('is-auto-ready');
      shotButton.classList.remove('is-auto-ready');
      startLiveCapture(kind, currentCaptureSettings().fps, format, true);
    }
    function waitForVideoData(video) {
      if (video.readyState >= 2) return Promise.resolve();
      return new Promise(function(resolve, reject) {
        const timer = window.setTimeout(function() {
          cleanup();
          reject(new Error('video_not_ready'));
        }, 3000);
        function cleanup() {
          window.clearTimeout(timer);
          video.removeEventListener('loadeddata', onReady);
          video.removeEventListener('canplay', onReady);
          video.removeEventListener('error', onError);
        }
        function onReady() {
          cleanup();
          resolve();
        }
        function onError() {
          cleanup();
          reject(new Error('video_failed'));
        }
        video.addEventListener('loadeddata', onReady);
        video.addEventListener('canplay', onReady);
        video.addEventListener('error', onError);
      });
    }
    function waitForPresentedFrame(video) {
      return new Promise(function(resolve) {
        let settled = false;
        const finish = function() {
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);
          resolve();
        };
        const timer = window.setTimeout(finish, 240);
        if (typeof video.requestVideoFrameCallback === 'function') {
          video.requestVideoFrameCallback(function() {
            finish();
          });
          return;
        }
        requestAnimationFrame(function() {
          finish();
        });
      });
    }
    async function waitForPresentedFrames(video, count) {
      for (let index = 0; index < count; index += 1) {
        await waitForPresentedFrame(video);
      }
    }
    function popupVideoMatchesTarget(video, target) {
      const width = video.videoWidth;
      const height = video.videoHeight;
      const rect = target.getBoundingClientRect();
      if (width <= 0 || height <= 0 || rect.width <= 0 || rect.height <= 0) return false;
      const sourceRatio = width / height;
      const targetRatio = rect.width / rect.height;
      return (
        Math.abs(sourceRatio - targetRatio) / targetRatio <= CAPTURE_STABILITY_TOLERANCE
      );
    }
    async function waitForStablePopupVideo(video, target) {
      const deadline = performance.now() + CAPTURE_STABILITY_TIMEOUT_MS;
      let stableWidth = 0;
      let stableHeight = 0;
      let stableFrames = 0;
      while (performance.now() < deadline) {
        const width = video.videoWidth;
        const height = video.videoHeight;
        if (popupVideoMatchesTarget(video, target)) {
          if (width === stableWidth && height === stableHeight) stableFrames += 1;
          else {
            stableWidth = width;
            stableHeight = height;
            stableFrames = 1;
          }
          if (stableFrames >= 2) {
            // 裁切后的尺寸稳定后再多丢几帧，避开轨道切换残留的整窗画面。
            await waitForPresentedFrames(video, 3);
            return true;
          }
        } else {
          stableFrames = 0;
        }
        await waitForPresentedFrame(video);
      }
      return false;
    }
    preview.addEventListener('load', markPreviewLoaded);
    window.addEventListener('load', markPreviewLoaded);
    window.setTimeout(markPreviewLoaded, PREVIEW_READY_TIMEOUT_MS);
    function cleanupStream() {
      if (activeVideo) {
        try {
          activeVideo.pause();
        } catch (_error) {}
        activeVideo.srcObject = null;
        activeVideo.remove();
        activeVideo = null;
      }
      if (activeStream) {
        activeStream.getTracks().forEach(function(track) {
          try {
            track.stop();
          } catch (_error) {}
        });
        activeStream = null;
      }
    }
    function settleFailure(message) {
      pendingRequest = '';
      clearTimeout(pendingTimer);
      cleanupStream();
      setPhase('idle');
      showStatus(message);
    }
    function settleCapture(requestId) {
      if (pendingRequest && pendingRequest !== requestId) return false;
      pendingRequest = '';
      clearTimeout(pendingTimer);
      return true;
    }
    async function startLiveCapture(kind, fps, format, auto) {
      if (phase !== 'idle') return;
      recordButton.classList.remove('is-auto-ready');
      shotButton.classList.remove('is-auto-ready');
      if (!window.opener || window.opener.closed) {
        settleFailure('独立预览已与宿主断开，请从会话重新打开');
        return;
      }
      if (!navigator.mediaDevices || typeof navigator.mediaDevices.getDisplayMedia !== 'function') {
        settleFailure('当前浏览器不支持实时预览捕获');
        return;
      }
      const requestId = 'cap-' + Date.now().toString(36) + '-' + (++captureSeq);
      pendingRequest = requestId;
      setPhase('requesting', '请在共享选择器中选择当前预览窗口…');
      clearTimeout(pendingTimer);
      pendingTimer = window.setTimeout(function() {
        if (pendingRequest !== requestId) return;
        settleFailure('捕获超时，请重试');
      }, CAPTURE_TIMEOUT_MS);

      let stream;
      try {
        // 必须在点击手势内同步进入：这是浏览器允许 getDisplayMedia 的前提。
        // 能力委托成功时，这一行由宿主用户手势授权，在页面渲染期间即可开始共享。
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: {
            frameRate: Math.max(1, Math.min(60, Math.round(fps || FALLBACK_CAPTURE_FPS)))
          },
          audio: false,
          preferCurrentTab: true
        });
      } catch (error) {
        if (pendingRequest !== requestId) return;
        const name = error && error.name;
        // 自动录制依赖 capability delegation；浏览器不支持、瞬态用户激活已过期，
        // 或用户取消共享时，都回落到弹窗内的一键开始，而不是让用户看到失败。
        if (auto && name !== 'NotSupportedError') {
          const label = AUTO_CAPTURE_KIND === 'still' ? '截图' : '录制';
          autoCapturePending = true;
          cleanupStream();
          pendingRequest = '';
          clearTimeout(pendingTimer);
          setPhase('idle');
          if (previewLoaded) showAutoReadyPrompt();
          else showStatus('页面渲染完成后点击「' + label + '」开始');
          return;
        }
        const denied = name === 'NotAllowedError' || name === 'PermissionDeniedError';
        settleFailure(denied ? '需要允许共享当前预览窗口' : '无法开始屏幕共享，请重试');
        return;
      }
      if (pendingRequest !== requestId) {
        stream.getTracks().forEach(function(track) {
          try {
            track.stop();
          } catch (_error) {}
        });
        return;
      }
      activeStream = stream;

      // 先等预览布局稳定，再把轨道裁到目标区域。顺序很重要：
      // CropTarget 必须取到最终矩形，视频也应该从裁切后的轨道开始解码。
      await previewReady;
      if (pendingRequest !== requestId) {
        cleanupStream();
        return;
      }

      // Chrome Region Capture：直接把视频轨裁到预览 iframe；不支持时宿主按 rect 裁。
      let cropped = false;
      try {
        const track = stream.getVideoTracks()[0];
        if (window.CropTarget && track && typeof track.cropTo === 'function') {
          const cropTarget = await window.CropTarget.fromElement(preview);
          await track.cropTo(cropTarget);
          cropped = true;
        }
      } catch (_error) {
        cropped = false;
      }
      if (pendingRequest !== requestId) {
        cleanupStream();
        return;
      }

      const video = document.createElement('video');
      video.id = CAPTURE_VIDEO_ID;
      video.muted = true;
      video.playsInline = true;
      video.autoplay = true;
      video.setAttribute('aria-hidden', 'true');
      video.style.cssText =
        'position:fixed;left:-10000px;top:0;width:2px;height:2px;opacity:0;pointer-events:none;';
      video.srcObject = stream;
      document.body.appendChild(video);
      activeVideo = video;
      try {
        await waitForVideoData(video);
        await video.play();
        // 首帧解码完成后再检查轨道尺寸；裁切结果反映到 videoWidth/videoHeight
        // 可能比 loadeddata 晚一拍。
        await waitForPresentedFrame(video);
      } catch (_error) {
        if (pendingRequest === requestId) settleFailure('无法读取屏幕共享画面，请重试');
        else cleanupStream();
        return;
      }
      if (pendingRequest !== requestId) {
        cleanupStream();
        return;
      }

      if (cropped) {
        const stable = await waitForStablePopupVideo(video, preview);
        if (!stable) {
          if (pendingRequest === requestId) {
            settleFailure('屏幕共享画面还未裁切到预览区域，请重试');
          } else {
            cleanupStream();
          }
          return;
        }
      } else {
        // 回退到 rect 裁切时没有轨道尺寸切换，但仍要丢掉首批未稳定的画面。
        await waitForPresentedFrames(video, 3);
      }
      if (pendingRequest !== requestId) {
        cleanupStream();
        return;
      }

      if (kind === 'record') setPhase('recording', '正在录制…');
      else setPhase('requesting', '正在生成截图…');
      window.opener.postMessage(
        {
          type: '${CAPTURE_STREAM_READY_TYPE}',
          requestId: requestId,
          kind: kind,
          format: format || undefined,
          cropped: cropped,
          provider: CAPTURE_PROVIDER,
          model: CAPTURE_MODEL
        },
        window.location.origin
      );
    }
    function cancelRecording() {
      if (!pendingRequest || phase !== 'recording') return;
      if (window.opener) {
        window.opener.postMessage(
          { type: '${CAPTURE_CANCEL_TYPE}', requestId: pendingRequest },
          window.location.origin
        );
      }
      setPhase('finishing', '正在完成录制…');
    }
    window.addEventListener('message', function(event) {
      if (event.origin !== window.location.origin) return;
      if (event.source !== window.opener) return;
      const data = event.data;
      if (data && data.type === AUTO_CAPTURE_START_TYPE) {
        handleDelegatedAutoStart(data);
        return;
      }
      if (!data || data.type !== '${CAPTURE_RESULT_TYPE}') return;
      if (pendingRequest && data.requestId !== pendingRequest) return;
      if (data.kind === 'progress') {
        if (data.phase === 'encoding' && phase !== 'finishing') {
          // 宿主已抓完帧，先释放屏幕共享指示器，再等编码产物。
          cleanupStream();
          setPhase('finishing', data.label || '正在编码…');
        } else {
          showStatus(data.label || '正在捕获…');
        }
        return;
      }
      if (!settleCapture(data.requestId)) return;
      cleanupStream();
      if (data.kind !== 'artifact' || !data.ok) {
        setPhase('idle');
        showStatus('捕获失败：' + ((data && data.message) || '未知错误'));
        return;
      }
      const link = document.createElement('a');
      link.href = data.url;
      link.download = data.fileName || 'html-preview';
      document.body.appendChild(link);
      link.click();
      link.remove();
      const notes = [];
      if (
        typeof data.effectiveFps === 'number' &&
        data.effectiveFps > 0 &&
        typeof data.targetFps === 'number' &&
        data.effectiveFps < data.targetFps * 0.8
      ) {
        notes.push(
          '实际约 ' + formatFps(data.effectiveFps) + 'fps（目标 ' + data.targetFps + 'fps）'
        );
      }
      setPhase('idle');
      if (notes.length) {
        showStatus('已保存 · ' + notes.join('；'));
      }
    });
    window.addEventListener('beforeunload', cleanupStream);
    captureButtons.forEach(function(button) {
      button.addEventListener('click', function() {
        const kind = button.dataset.capture === 'record' ? 'record' : 'still';
        if (kind === 'record' && phase === 'recording') {
          cancelRecording();
          return;
        }
        if (phase !== 'idle') return;
        // 截图与录制都走实时屏幕共享：脚本、Canvas、动画和鼠标交互都必须保留。
        // 从会话跳转过来的录制沿用用户选中的格式；手动打开的弹窗交回宿主按偏好解析。
        startLiveCapture(
          kind,
          currentCaptureSettings().fps,
          kind === 'record' ? AUTO_CAPTURE_FORMAT || undefined : undefined,
          false
        );
      });
    });
  </script>
</body>
</html>`;
}

export function openHtmlPreviewWindow(
  documentContent: string,
  options: HtmlPreviewWindowOptions
): Window | null {
  if (typeof window === 'undefined' || typeof Blob === 'undefined') return null;

  const previewDocument = buildHtmlPreviewWindowDocument(documentContent, options);
  // 捕获桥要求弹窗持有 window.opener：必须用 window.open（或显式 rel=opener）。
  // <a target="_blank"> 会被现代浏览器隐式加上 noopener，导致弹窗无法回传捕获结果。
  // 弹窗首屏脚本全部是本模块生成的编排代码，用户 HTML 隔离在 sandbox iframe 内，风险可控。
  ensurePreviewWindowCaptureHost();

  if (options.autoCapture) {
    // about:blank + document.write 让我们在同一个用户手势内拿到弹窗引用，
    // 并尝试用 capability delegation 把 getDisplayMedia 的自旋授权交给弹窗。
    // 浏览器不支持时，弹窗会在页面渲染完成后显示明确的一键录制入口。
    const popup = window.open('', '_blank');
    if (!popup) return null;
    let wroteDocument = false;
    try {
      popup.document.open();
      popup.document.write(previewDocument);
      popup.document.close();
      wroteDocument = true;
    } catch {
      // 某些浏览器/安全策略不允许写 about:blank，回退到 blob 页面。
    }
    if (!wroteDocument) {
      const fallbackUrl = window.URL.createObjectURL(
        new Blob([previewDocument], { type: 'text/html' })
      );
      popup.location.href = fallbackUrl;
      window.setTimeout(
        () => window.URL.revokeObjectURL(fallbackUrl),
        PREVIEW_URL_REVOKE_DELAY_MS
      );
      return popup;
    }
    try {
      const postDelegated = popup.postMessage as unknown as CapabilityDelegatingPostMessage;
      postDelegated.call(
        popup,
        {
          type: CAPTURE_AUTO_START_TYPE,
          kind: options.autoCapture.kind,
          format: options.autoCapture.format
        },
        window.location.origin,
        { delegate: 'display-capture' }
      );
    } catch {
      // 能力委托需要浏览器支持且宿主仍持有瞬态用户激活；失败时走弹窗内兜底。
    }
    try {
      popup.focus();
    } catch {
      // 浏览器拒绝聚焦不影响弹窗已经打开。
    }
    return popup;
  }

  const previewUrl = window.URL.createObjectURL(new Blob([previewDocument], { type: 'text/html' }));
  const popup = window.open(previewUrl, '_blank');
  if (!popup) {
    window.URL.revokeObjectURL(previewUrl);
    return null;
  }
  try {
    popup.focus();
  } catch {
    // 浏览器拒绝聚焦不影响弹窗已经打开。
  }
  window.setTimeout(() => window.URL.revokeObjectURL(previewUrl), PREVIEW_URL_REVOKE_DELAY_MS);
  return popup;
}
