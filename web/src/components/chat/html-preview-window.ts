import {
  detectScriptDependentHtml,
  describeScriptDependentReasons,
  ensurePreviewWindowCaptureHost,
  readCapturePreferences,
  summarizeRecordingSettings
} from '../../features/capture';

export type HtmlPreviewDevice = 'desktop' | 'mobile';

export interface HtmlPreviewWindowOptions {
  device: HtmlPreviewDevice;
  title?: string;
  /** 录制条件摘要；省略时读取全局录制设置。 */
  recordingHint?: string;
}

export interface PopupCaptureSettings {
  scope: 'full' | 'live';
  fps: number;
}

/**
 * 弹窗点击捕获时的偏好解析（纯函数）。
 *
 * 弹窗文档在打开时就把脚本写死了，如果沿用构建期快照，用户之后在设置页改的
 * 捕获范围/帧率不会生效。这里允许把函数体原样注入弹窗脚本（toString），
 * 因此它必须自包含：不能引用模块里的其它常量或函数。
 */
export function parsePopupCaptureSettings(
  raw: string | null | undefined,
  fallbackScope: 'full' | 'live' = 'full',
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
  const fallback: PopupCaptureSettings = {
    scope: fallbackScope === 'live' ? 'live' : 'full',
    fps:
      typeof fallbackFps === 'number' && Number.isFinite(fallbackFps) && fallbackFps > 0
        ? nearest(fallbackFps)
        : 30
  };
  if (!raw) return fallback;
  try {
    const value = JSON.parse(raw) as {
      captureScope?: unknown;
      recording?: { fps?: unknown };
    };
    const recordedFps = value?.recording?.fps;
    return {
      scope: value?.captureScope === 'live' ? 'live' : 'full',
      fps:
        typeof recordedFps === 'number' && Number.isFinite(recordedFps) && recordedFps > 0
          ? nearest(recordedFps)
          : fallback.fps
    };
  } catch {
    return fallback;
  }
}

const HTML_PREVIEW_SANDBOX = 'allow-scripts allow-forms allow-modals allow-popups allow-downloads';
const PREVIEW_URL_REVOKE_DELAY_MS = 60_000;

/** 与宿主 preview-window-host.ts 约定的消息契约（弹窗侧不能 import，保持常量同步）。 */
const CAPTURE_REQUEST_TYPE = 'aih:html-preview-capture-request';
const CAPTURE_RESULT_TYPE = 'aih:html-preview-capture-result';
const CAPTURE_CANCEL_TYPE = 'aih:html-preview-capture-cancel';
const CAPTURE_STREAM_READY_TYPE = 'aih:html-preview-capture-stream-ready';

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
  const fallbackScope = preferences.captureScope === 'live' ? 'live' : 'full';
  const fallbackFps = Math.max(1, Math.min(60, Math.round(preferences.recording.fps)));
  const dynamicReasons = detectScriptDependentHtml(documentContent);
  const dynamicLabel = describeScriptDependentReasons(dynamicReasons);

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

    // 捕获桥（弹窗侧）：
    // - 截图：范围由偏好决定。full 把原始文档投回宿主重新渲染整页（不执行脚本）；
    //   live 在点击手势里拿屏幕共享，保留脚本与动画。
    // - 录制：始终走实时画面（脚本、Canvas、鼠标交互），不重新渲染。
    // 两条路径都由宿主的同一条编码派发产出产物。
    const status = document.querySelector('[data-capture-status]');
    const recordButton = document.querySelector('[data-capture="record"]');
    const shotButton = document.querySelector('[data-capture="screenshot"]');
    const captureButtons = [shotButton, recordButton];
    const CAPTURE_TIMEOUT_MS = 300000;
    const CAPTURE_VIDEO_ID = 'aih-capture-video';
    const CAPTURE_PREFS_KEY = 'aih.capture';
    const FALLBACK_CAPTURE_SCOPE = ${JSON.stringify(fallbackScope)};
    const FALLBACK_CAPTURE_FPS = ${fallbackFps};
    const HAS_DYNAMIC_CONTENT = ${dynamicReasons.length > 0 ? 'true' : 'false'};
    const DYNAMIC_CONTENT_LABEL = ${JSON.stringify(dynamicLabel)};
    // 点击时重新解析偏好：弹窗打开后用户在设置页的修改也要立即生效。
    const readLiveCaptureSettings = ${parsePopupCaptureSettings.toString()};
    let captureSeq = 0;
    let pendingRequest = '';
    let pendingTimer = 0;
    let phase = 'idle';
    let activeCaptureMode = 'full';
    let activeCaptureKind = 'still';
    let activeStream = null;
    let activeVideo = null;

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
        FALLBACK_CAPTURE_SCOPE,
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
    function showLiveSuggestion(kind, label) {
      status.textContent = label ? label + ' · ' : '';
      status.hidden = false;
      const action = document.createElement('button');
      action.type = 'button';
      action.className = 'status-action';
      action.textContent = '改用实时画面';
      action.addEventListener('click', function() {
        setPhase('idle');
        startLiveCapture(kind, currentCaptureSettings().fps);
      });
      status.appendChild(action);
    }
    function setPhase(next, label) {
      phase = next;
      recordButton.textContent =
        next === 'recording' ? '停止' : next === 'requesting' ? '请求中…' : '录制';
      recordButton.classList.toggle('is-recording', next === 'recording');
      recordButton.setAttribute('aria-pressed', String(next === 'recording'));
      recordButton.disabled = next === 'requesting' || next === 'finishing';
      shotButton.disabled = next !== 'idle';
      if (label) showStatus(label);
      else if (next === 'idle') {
        status.hidden = true;
        status.textContent = '';
      }
    }
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
    function startDocumentCapture(kind) {
      if (phase !== 'idle') return;
      if (!window.opener) {
        settleFailure('宿主页面已关闭，无法捕获');
        return;
      }
      activeCaptureMode = 'full';
      activeCaptureKind = kind;
      const requestId = 'cap-' + Date.now().toString(36) + '-' + (++captureSeq);
      pendingRequest = requestId;
      setPhase('requesting', kind === 'record' ? '正在渲染完整页面…' : '正在生成截图…');
      clearTimeout(pendingTimer);
      pendingTimer = window.setTimeout(function() {
        if (pendingRequest !== requestId) return;
        settleFailure('捕获超时，请重试');
      }, CAPTURE_TIMEOUT_MS);
      // 完整页面模式：把弹窗里的原始文档 + 逻辑宽度投回宿主，由宿主重新渲染
      // 整页内容（不执行脚本），不申请屏幕共享、也不受当前视口裁剪。
      window.opener.postMessage(
        {
          type: '${CAPTURE_REQUEST_TYPE}',
          requestId: requestId,
          kind: kind,
          html: preview.srcdoc,
          width: Math.max(1, Math.round(preview.clientWidth))
        },
        window.location.origin
      );
      // 录制请求发出后即可停止（宿主会在停止信号后编码已抓到的帧）。
      if (kind === 'record') setPhase('recording', '正在捕获完整页面…');
    }
    async function startLiveCapture(kind, fps) {
      if (phase !== 'idle') return;
      if (!window.opener) {
        settleFailure('宿主页面已关闭，无法捕获');
        return;
      }
      if (!navigator.mediaDevices || typeof navigator.mediaDevices.getDisplayMedia !== 'function') {
        settleFailure('当前浏览器不支持实时预览捕获');
        return;
      }
      activeCaptureMode = 'live';
      activeCaptureKind = kind;
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
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: {
            frameRate: Math.max(1, Math.min(60, Math.round(fps || FALLBACK_CAPTURE_FPS)))
          },
          audio: false,
          preferCurrentTab: true
        });
      } catch (error) {
        if (pendingRequest !== requestId) return;
        const denied =
          error && (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError');
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
        await new Promise(function(resolve, reject) {
          if (video.readyState >= 1) {
            resolve();
            return;
          }
          video.addEventListener('loadedmetadata', resolve, { once: true });
          video.addEventListener(
            'error',
            function() {
              reject(new Error('video_failed'));
            },
            { once: true }
          );
        });
        await video.play();
      } catch (_error) {
        if (pendingRequest === requestId) settleFailure('无法读取屏幕共享画面，请重试');
        else cleanupStream();
        return;
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
          cropped: cropped
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
      const data = event.data;
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
      if (data.notice === 'content_truncated') {
        notes.push('页面超出可捕获高度，底部内容已截断');
      }
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
      if (activeCaptureMode === 'full' && HAS_DYNAMIC_CONTENT) {
        const prefix = notes.length ? notes.join('；') + '；' : '';
        showLiveSuggestion(
          activeCaptureKind,
          prefix + '完整页面不执行脚本（检测到' + DYNAMIC_CONTENT_LABEL + '）'
        );
      } else if (notes.length) {
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
        const settings = currentCaptureSettings();
        // 录制始终走实时屏幕共享：脚本、Canvas 和鼠标交互都必须保留；
        // 完整页面静态克隆只用于截图。
        if (kind === 'record' || settings.scope === 'live') {
          startLiveCapture(kind, settings.fps);
        } else {
          startDocumentCapture(kind);
        }
      });
    });
  </script>
</body>
</html>`;
}

export function openHtmlPreviewWindow(
  documentContent: string,
  options: HtmlPreviewWindowOptions
) {
  if (typeof window === 'undefined' || typeof Blob === 'undefined') return false;

  const previewDocument = buildHtmlPreviewWindowDocument(documentContent, options);
  const previewUrl = window.URL.createObjectURL(new Blob([previewDocument], { type: 'text/html' }));
  // 捕获桥要求弹窗持有 window.opener：这里不能加 noopener/noreferrer。
  // 弹窗首屏脚本全部是本模块生成的编排代码，用户 HTML 隔离在 sandbox iframe 内，风险可控。
  ensurePreviewWindowCaptureHost();
  const link = window.document.createElement('a');
  link.href = previewUrl;
  link.target = '_blank';
  link.click();
  window.setTimeout(() => window.URL.revokeObjectURL(previewUrl), PREVIEW_URL_REVOKE_DELAY_MS);
  return true;
}
